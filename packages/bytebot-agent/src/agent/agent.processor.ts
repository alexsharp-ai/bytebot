import { TasksService } from '../tasks/tasks.service';
import { MessagesService } from '../messages/messages.service';
import { Injectable, Logger } from '@nestjs/common';
import { Role, Task, TaskPriority, TaskStatus, TaskType } from '@prisma/client';
import { AnthropicService } from '../anthropic/anthropic.service';
import {
  isComputerToolUseContentBlock,
  isSetTaskStatusToolUseBlock,
  isCreateTaskToolUseBlock,
  SetTaskStatusToolUseBlock,
} from '@bytebot/shared';

import {
  MessageContentBlock,
  MessageContentType,
  ToolResultContentBlock,
  TextContentBlock,
} from '@bytebot/shared';
import { InputCaptureService } from './input-capture.service';
import { OnEvent } from '@nestjs/event-emitter';
import { OpenAIService } from '../openai/openai.service';
import { GoogleService } from '../google/google.service';
import {
  BytebotAgentModel,
  BytebotAgentService,
  BytebotAgentResponse,
} from './agent.types';
import {
  AGENT_SYSTEM_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
} from './agent.constants';
import { SummariesService } from '../summaries/summaries.service';
import { handleComputerToolUse } from './agent.computer-use';
import { ProxyService } from '../proxy/proxy.service';

@Injectable()
export class AgentProcessor {
  private readonly logger = new Logger(AgentProcessor.name);
  private currentTaskId: string | null = null;
  private isProcessing = false;
  private abortController: AbortController | null = null;
  private services: Record<string, BytebotAgentService> = {};
  private retryCounts: Record<string, number> = {};
  private readonly MAX_INTERRUPT_RETRIES = 3;
  private computerToolFailures: Record<string, number> = {};
  private computerToolsDisabled: Record<string, boolean> = {};

  private normalizeError(e: unknown): { message: string; stack?: string } {
    if (e instanceof Error) return { message: e.message, stack: e.stack };
    try {
      return { message: typeof e === 'string' ? e : JSON.stringify(e) };
    } catch {
      return { message: 'Unknown error' };
    }
  }

  constructor(
    private readonly tasksService: TasksService,
    private readonly messagesService: MessagesService,
    private readonly summariesService: SummariesService,
    private readonly anthropicService: AnthropicService,
    private readonly openaiService: OpenAIService,
    private readonly googleService: GoogleService,
    private readonly proxyService: ProxyService,
    private readonly inputCaptureService: InputCaptureService,
  ) {
    this.services = {
      anthropic: this.anthropicService,
      openai: this.openaiService,
      google: this.googleService,
      proxy: this.proxyService,
    };
    this.logger.log('AgentProcessor initialized');
  }

  /**
   * Check if the processor is currently processing a task
   */
  isRunning(): boolean {
    return this.isProcessing;
  }

  /**
   * Get the current task ID being processed
   */
  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  @OnEvent('task.takeover')
  handleTaskTakeover({ taskId }: { taskId: string }) {
    this.logger.log(`Task takeover event received for task ID: ${taskId}`);

    // If the agent is still processing this task, abort any in-flight operations
    if (this.currentTaskId === taskId && this.isProcessing) {
      this.abortController?.abort();
    }

    // Always start capturing user input so that emitted actions are received
    this.inputCaptureService.start(taskId);
  }

  @OnEvent('task.resume')
  handleTaskResume({ taskId }: { taskId: string }) {
    if (this.currentTaskId === taskId && this.isProcessing) {
      this.logger.log(`Task resume event received for task ID: ${taskId}`);
      this.abortController = new AbortController();

      void this.runIteration(taskId);
    }
  }

  @OnEvent('task.cancel')
  async handleTaskCancel({ taskId }: { taskId: string }) {
    this.logger.log(`Task cancel event received for task ID: ${taskId}`);

    await this.stopProcessing();
  }

  processTask(taskId: string) {
    this.logger.log(`Starting processing for task ID: ${taskId}`);

    if (this.isProcessing) {
      this.logger.warn('AgentProcessor is already processing another task');
      return;
    }

    this.isProcessing = true;
    this.currentTaskId = taskId;
    this.abortController = new AbortController();

    // Kick off the first iteration without blocking the caller
    void this.runIteration(taskId);
  }

  /**
   * Runs a single iteration of task processing and schedules the next
   * iteration via setImmediate while the task remains RUNNING.
   */
  private async runIteration(taskId: string): Promise<void> {
    if (!this.isProcessing) {
      return;
    }

    try {
      const task: Task = await this.tasksService.findById(taskId);

      if (task.status !== TaskStatus.RUNNING) {
        this.logger.log(
          `Task processing completed for task ID: ${taskId} with status: ${task.status}`,
        );
        this.isProcessing = false;
        this.currentTaskId = null;
        return;
      }

      this.logger.log(`Processing iteration for task ID: ${taskId}`);

      // Refresh abort controller for this iteration to avoid accumulating
      // "abort" listeners on a single AbortSignal across iterations.
      this.abortController = new AbortController();

      const latestSummary = await this.summariesService.findLatest(taskId);
      const unsummarizedMessages =
        await this.messagesService.findUnsummarized(taskId);
      const messages = [
        ...(latestSummary
          ? [
              {
                id: '',
                createdAt: new Date(),
                updatedAt: new Date(),
                taskId,
                summaryId: null,
                role: Role.USER,
                content: [
                  {
                    type: MessageContentType.Text,
                    text: latestSummary.content,
                  },
                ],
              },
            ]
          : []),
        ...unsummarizedMessages,
        // If desktop automation has been disabled for this task, inject an advisory message
        ...(this.computerToolsDisabled[taskId]
          ? [
              {
                id: '',
                createdAt: new Date(),
                updatedAt: new Date(),
                taskId,
                summaryId: null,
                role: Role.USER,
                content: [
                  {
                    type: MessageContentType.Text,
                    text: 'System notice: Desktop automation tools (computer_*) are unavailable. Do not request computer_* tool calls. Provide next instructions or ask the user for needed information instead.',
                  },
                ],
              },
            ]
          : []),
      ];
      this.logger.debug(
        `Sending ${messages.length} messages to LLM for processing`,
      );

      const rawModel = task.model as unknown;
      let model: BytebotAgentModel;
      if (
        rawModel &&
        typeof rawModel === 'object' &&
        !Array.isArray(rawModel)
      ) {
        const obj = rawModel as Record<string, unknown>;
        if (typeof obj.provider === 'string' && typeof obj.name === 'string') {
          model = {
            provider: obj.provider as BytebotAgentModel['provider'],
            name: String(obj.name),
            title: typeof obj.title === 'string' ? obj.title : String(obj.name),
            contextWindow:
              typeof obj.contextWindow === 'number'
                ? obj.contextWindow
                : undefined,
          };
        } else if (typeof obj.name === 'string') {
          const name = String(obj.name);
          model = {
            provider: inferProvider(name),
            name,
            title: typeof obj.title === 'string' ? obj.title : name,
          };
        } else {
          model = {
            provider: 'openai',
            name: 'gpt-4.1-mini',
            title: 'gpt-4.1-mini',
          };
        }
      } else if (typeof rawModel === 'string') {
        model = {
          provider: inferProvider(rawModel),
          name: rawModel,
          title: rawModel,
        };
      } else {
        model = {
          provider: 'openai',
          name: 'gpt-4.1-mini',
          title: 'gpt-4.1-mini',
        };
      }
      let agentResponse: BytebotAgentResponse;

      const service = this.services[model.provider];
      if (!service) {
        this.logger.warn(
          `No service found for model provider: ${model.provider}`,
        );
        await this.tasksService.update(taskId, {
          status: TaskStatus.FAILED,
        });
        this.isProcessing = false;
        this.currentTaskId = null;
        return;
      }

      try {
        agentResponse = await service.generateMessage(
          AGENT_SYSTEM_PROMPT,
          messages,
          model.name,
          true,
          this.abortController.signal,
        );
      } catch (llmErr: unknown) {
        const { message, stack } = this.normalizeError(llmErr);
        this.logger.error(
          `LLM call failed for task ${taskId} (provider=${model.provider}, model=${model.name}): ${message}`,
          stack,
        );
        await this.tasksService.update(taskId, {
          status: TaskStatus.FAILED,
          error: message.slice(0, 500) || 'LLM error',
        });
        this.isProcessing = false;
        this.currentTaskId = null;
        return;
      }

      const messageContentBlocks = agentResponse.contentBlocks;

      this.logger.debug(
        `Received ${messageContentBlocks.length} content blocks from LLM`,
      );

      if (messageContentBlocks.length === 0) {
        this.logger.warn(
          `Task ID: ${taskId} received no content blocks from LLM, marking as failed`,
        );
        await this.tasksService.update(taskId, {
          status: TaskStatus.FAILED,
          error: 'No content blocks returned from model',
        });
        this.isProcessing = false;
        this.currentTaskId = null;
        return;
      }

      await this.messagesService.create({
        content: messageContentBlocks,
        role: Role.ASSISTANT,
        taskId,
      });

      // Calculate if we need to summarize based on token usage
      const contextWindow = model.contextWindow || 200000; // Default to 200k if not specified
      const contextThreshold = contextWindow * 0.75;
      const shouldSummarize =
        agentResponse.tokenUsage.totalTokens >= contextThreshold;

      if (shouldSummarize) {
        try {
          // After we've successfully generated a response, we can summarize the unsummarized messages
          const summaryResponse = await service.generateMessage(
            SUMMARIZATION_SYSTEM_PROMPT,
            [
              ...messages,
              {
                id: '',
                createdAt: new Date(),
                updatedAt: new Date(),
                taskId,
                summaryId: null,
                role: Role.USER,
                content: [
                  {
                    type: MessageContentType.Text,
                    text: 'Respond with a summary of the messages above. Do not include any additional information.',
                  },
                ],
              },
            ],
            model.name,
            false,
            this.abortController.signal,
          );

          const summaryContentBlocks = summaryResponse.contentBlocks;

          this.logger.debug(
            `Received ${summaryContentBlocks.length} summary content blocks from LLM`,
          );
          const summaryContent = summaryContentBlocks
            .filter(
              (block: MessageContentBlock) =>
                block.type === MessageContentType.Text,
            )
            .map((block: TextContentBlock) => block.text)
            .join('\n');

          const summary = await this.summariesService.create({
            content: summaryContent,
            taskId,
          });

          await this.messagesService.attachSummary(taskId, summary.id, [
            ...messages.map((message) => {
              return message.id;
            }),
          ]);

          this.logger.log(
            `Generated summary for task ${taskId} due to token usage (${agentResponse.tokenUsage.totalTokens}/${contextWindow})`,
          );
        } catch (error: unknown) {
          const { message: sumMsg, stack: sumStack } =
            this.normalizeError(error);
          this.logger.error(
            `Error summarizing messages for task ${taskId}: ${sumMsg}`,
            sumStack,
          );
        }
      }

      this.logger.debug(
        `Token usage for task ${taskId}: ${agentResponse.tokenUsage.totalTokens}/${contextWindow} (${Math.round((agentResponse.tokenUsage.totalTokens / contextWindow) * 100)}%)`,
      );

      const generatedToolResults: ToolResultContentBlock[] = [];

      let setTaskStatusToolUseBlock: SetTaskStatusToolUseBlock | null = null;

      for (const block of messageContentBlocks) {
        if (isComputerToolUseContentBlock(block)) {
          const result = await handleComputerToolUse(block, this.logger);
          generatedToolResults.push(result);

          // Track failures for computer_* tools (e.g., network/desktop backend issues)
          if (result.is_error && block.name.startsWith('computer_')) {
            const failures = (this.computerToolFailures[taskId] || 0) + 1;
            this.computerToolFailures[taskId] = failures;
            if (failures >= 2 && !this.computerToolsDisabled[taskId]) {
              this.computerToolsDisabled[taskId] = true;
              this.logger.warn(
                `Disabling further computer_* tool attempts for task ${taskId} after ${failures} failures`,
              );
              await this.tasksService.update(taskId, {
                status: TaskStatus.NEEDS_HELP,
                error:
                  'Desktop automation unavailable. Please provide guidance or perform actions manually.',
              });
              // Stop further processing iterations until user resumes / takes over
              this.isProcessing = false;
              this.currentTaskId = null;
              return;
            }
          }
        }

        if (isCreateTaskToolUseBlock(block)) {
          const type = block.input.type?.toUpperCase() as TaskType;
          const priority = block.input.priority?.toUpperCase() as TaskPriority;

          await this.tasksService.create({
            description: block.input.description,
            type,
            createdBy: Role.ASSISTANT,
            ...(block.input.scheduledFor && {
              scheduledFor: new Date(block.input.scheduledFor),
            }),
            model: task.model,
            priority,
          });

          generatedToolResults.push({
            type: MessageContentType.ToolResult,
            tool_use_id: block.id,
            content: [
              {
                type: MessageContentType.Text,
                text: 'The task has been created',
              },
            ],
          });
        }

        if (isSetTaskStatusToolUseBlock(block)) {
          setTaskStatusToolUseBlock = block;

          generatedToolResults.push({
            type: MessageContentType.ToolResult,
            tool_use_id: block.id,
            is_error: block.input.status === 'failed',
            content: [
              {
                type: MessageContentType.Text,
                text: block.input.description,
              },
            ],
          });
        }
      }

      if (generatedToolResults.length > 0) {
        await this.messagesService.create({
          content: generatedToolResults,
          role: Role.USER,
          taskId,
        });
      }

      // Update the task status after all tool results have been generated if we have a set task status tool use block
      if (setTaskStatusToolUseBlock) {
        switch (setTaskStatusToolUseBlock.input.status) {
          case 'completed':
            await this.tasksService.update(taskId, {
              status: TaskStatus.COMPLETED,
              completedAt: new Date(),
            });
            break;
          case 'needs_help':
            await this.tasksService.update(taskId, {
              status: TaskStatus.NEEDS_HELP,
            });
            break;
        }
      }

      // Schedule the next iteration without blocking
      if (this.isProcessing) {
        setImmediate(() => {
          void this.runIteration(taskId);
        });
      }
    } catch (err: unknown) {
      const { message, stack } = this.normalizeError(err);
      // BytebotAgentInterrupt identification via name or exact message
      const errName = (err as { name?: string } | undefined)?.name;
      const isInterrupt =
        errName === 'BytebotAgentInterrupt' ||
        message === 'BytebotAgentInterrupt';
      if (isInterrupt) {
        const current = this.retryCounts[taskId] || 0;
        if (current < this.MAX_INTERRUPT_RETRIES) {
          this.retryCounts[taskId] = current + 1;
          this.logger.warn(
            `Processing interrupted for task ${taskId}. Retry ${this.retryCounts[taskId]}/${this.MAX_INTERRUPT_RETRIES}`,
          );
          // small delay before retry to avoid tight loop
          setTimeout(() => {
            if (this.isProcessing && this.currentTaskId === taskId) {
              this.runIteration(taskId).catch((retryErr) => {
                const { message: retryMsg, stack: retryStack } =
                  this.normalizeError(retryErr);
                this.logger.error(
                  `Retry iteration failed for task ${taskId}: ${retryMsg}`,
                  retryStack,
                );
              });
            }
          }, 500);
          return; // keep processing state
        }
        this.logger.warn(
          `Processing interrupted for task ${taskId} after ${current} retries. Marking NEEDS_HELP.`,
        );
        await this.tasksService.update(taskId, {
          status: TaskStatus.NEEDS_HELP,
          error:
            'Processing interrupted multiple times (model/tool aborted). You can resume or take over.',
        });
      } else {
        this.logger.error(
          `Error in processing iteration for task ${taskId}: ${message}`,
          stack,
        );
        await this.tasksService.update(taskId, {
          status: TaskStatus.FAILED,
          error: message.slice(0, 500) || 'Processing error',
        });
      }
      delete this.retryCounts[taskId];
      this.isProcessing = false;
      this.currentTaskId = null;
    }
  }

  async stopProcessing(): Promise<void> {
    if (!this.isProcessing) {
      return;
    }

    this.logger.log(`Stopping execution of task ${this.currentTaskId}`);

    // Signal any in-flight async operations to abort
    this.abortController?.abort();

    await this.inputCaptureService.stop();

    this.isProcessing = false;
    this.currentTaskId = null;
  }
}

function inferProvider(
  name: string,
): 'anthropic' | 'openai' | 'google' | 'proxy' {
  if (name.startsWith('claude')) return 'anthropic';
  if (name.startsWith('gemini')) return 'google';
  if (name.startsWith('gpt-') || name.includes('openai')) return 'openai';
  return 'proxy';
}
