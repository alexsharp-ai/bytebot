import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  HttpStatus,
  HttpCode,
  Query,
  HttpException,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
// Removed Prisma Task/Message type imports due to schema changes; using 'any' where necessary.
import { AddTaskMessageDto } from './dto/add-task-message.dto';
import { MessagesService } from '../messages/messages.service';
import { ANTHROPIC_MODELS } from '../anthropic/anthropic.constants';
import { Task } from '@prisma/client';
import { OPENAI_MODELS } from '../openai/openai.constants';
import { GOOGLE_MODELS } from '../google/google.constants';
import { BytebotAgentModel } from 'src/agent/agent.types';

interface ProxyModelRecord {
  litellm_params?: { model?: string };
  model_name?: string;
  [k: string]: unknown;
}

const proxyUrl = process.env.BYTEBOT_LLM_PROXY_URL;

@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly messagesService: MessagesService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() createTaskDto: CreateTaskDto): Promise<Task> {
    return this.tasksService.create(createTaskDto);
  }

  @Get()
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('statuses') statuses?: string,
  ): Promise<{ tasks: Task[]; total: number; totalPages: number }> {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    // Handle both single status and multiple statuses
    let statusFilter: string[] | undefined;
    if (statuses) {
      statusFilter = statuses.split(',');
    } else if (status) {
      statusFilter = [status];
    }

    return this.tasksService.findAll(pageNum, limitNum, statusFilter);
  }

  @Get('models')
  async getModels() {
    if (proxyUrl) {
      try {
        const response = await fetch(`${proxyUrl}/model/info`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          throw new HttpException(
            `Failed to fetch models from proxy: ${response.statusText}`,
            HttpStatus.BAD_GATEWAY,
          );
        }

        const proxyJson: unknown = await response.json();
        const data =
          proxyJson && typeof proxyJson === 'object'
            ? (proxyJson as { data?: unknown }).data
            : undefined;
        if (!Array.isArray(data)) return [];
        const safe: ProxyModelRecord[] = data.filter(
          (m): m is ProxyModelRecord =>
            !!m && typeof m === 'object' && 'litellm_params' in m,
        );
        return safe
          .filter((m) => m.litellm_params?.model)
          .map((m) => {
            const modelName = m.litellm_params?.model || 'unknown';
            return {
              provider: 'proxy',
              name: modelName,
              title: String(m.model_name || modelName),
              contextWindow: 128000,
            } as BytebotAgentModel;
          });
      } catch (err: unknown) {
        if (err instanceof HttpException) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new HttpException(
          `Error fetching models: ${msg}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }

    // Dynamically compute models at request time based on current env
    const dynamicModels: BytebotAgentModel[] = [
      ...(process.env.ANTHROPIC_API_KEY ? ANTHROPIC_MODELS : []),
      ...(process.env.OPENAI_API_KEY ? OPENAI_MODELS : []),
      ...(process.env.GEMINI_API_KEY ? GOOGLE_MODELS : []),
    ];

    if (dynamicModels.length === 0) {
      throw new HttpException(
        'No LLM models configured. Set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return dynamicModels;
  }

  @Get(':id')
  async findById(@Param('id') id: string): Promise<any> {
    return this.tasksService.findById(id);
  }

  @Get(':id/messages')
  async taskMessages(
    @Param('id') taskId: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ): Promise<any[]> {
    const options = {
      limit: limit ? parseInt(limit, 10) : undefined,
      page: page ? parseInt(page, 10) : undefined,
    };

    const messages = await this.messagesService.findAll(taskId, options);
    return messages;
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  async addTaskMessage(
    @Param('id') taskId: string,
    @Body() guideTaskDto: AddTaskMessageDto,
  ): Promise<Task> {
    return this.tasksService.addTaskMessage(taskId, guideTaskDto);
  }

  @Get(':id/messages/raw')
  async taskRawMessages(
    @Param('id') taskId: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ): Promise<any[]> {
    const options = {
      limit: limit ? parseInt(limit, 10) : undefined,
      page: page ? parseInt(page, 10) : undefined,
    };

    return this.messagesService.findRawMessages(taskId, options);
  }

  @Get(':id/messages/processed')
  async taskProcessedMessages(
    @Param('id') taskId: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ) {
    const options = {
      limit: limit ? parseInt(limit, 10) : undefined,
      page: page ? parseInt(page, 10) : undefined,
    };

    return this.messagesService.findProcessedMessages(taskId, options);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string): Promise<void> {
    await this.tasksService.delete(id);
  }

  @Post(':id/takeover')
  @HttpCode(HttpStatus.OK)
  async takeOver(@Param('id') taskId: string): Promise<Task> {
    return this.tasksService.takeOver(taskId);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  async resume(@Param('id') taskId: string): Promise<Task> {
    return this.tasksService.resume(taskId);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Param('id') taskId: string): Promise<Task> {
    return this.tasksService.cancel(taskId);
  }
}
