"use client";

import React, { useRef, useEffect, useState, useCallback } from "react";

interface VncViewerProps {
  viewOnly?: boolean;
}

export function VncViewer({ viewOnly = true }: VncViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [VncComponent, setVncComponent] = useState<any>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<
    "idle" | "connecting" | "connected" | "disconnected" | "error"
  >("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const MAX_RETRIES = 5;
  const RETRY_BASE_DELAY = 1500; // ms

  useEffect(() => {
    // Dynamically import the VncScreen component only on the client side
    import("react-vnc").then(({ VncScreen }) => {
      setVncComponent(() => VncScreen);
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return; // SSR safety‑net
    // In Next.js client components only NEXT_PUBLIC_* vars are embedded.
    const envUrl =
      process.env.NEXT_PUBLIC_DESKTOP_VNC_URL ||
      process.env.BYTEBOT_DESKTOP_VNC_URL; // fallback if manually inlined
    if (envUrl) {
      setWsUrl(envUrl);
      return;
    }
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    setWsUrl(`${proto}://${window.location.host}/api/proxy/websockify`);
  }, []);

  const handleDisconnect = useCallback(
    (message: string, willRetry: boolean) => {
      setStatus("disconnected");
      setLastError(message);
      if (willRetry && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt); // exponential backoff
        const nextAttempt = attempt + 1;
        setAttempt(nextAttempt);
        setTimeout(() => {
          setStatus("connecting");
          // Force remount by tweaking wsUrl with a cache buster to avoid stale socket reuse
          setWsUrl((prev) => (prev ? `${prev.split("?")[0]}?r=${Date.now()}` : prev));
        }, delay);
      }
    },
    [attempt],
  );

  return (
    <div ref={containerRef} className="h-full w-full">
      {VncComponent && wsUrl && (
        <VncComponent
          rfbOptions={{
            secure: false,
            shared: true,
            wsProtocols: ["binary"],
          }}
          key={`${viewOnly ? "view-only" : "interactive"}-${attempt}`}
          url={wsUrl}
          scaleViewport
          viewOnly={viewOnly}
          onConnect={() => {
            setStatus("connected");
            setLastError(null);
          }}
          onDisconnect={(evt: { detail?: unknown }) => {
            const { detail } = evt;
            handleDisconnect(
              typeof detail === "string" ? detail : "Disconnected",
              true,
            );
          }}
          onSecurityFailure={(evt: { detail?: unknown }) => {
            const { detail } = evt;
            handleDisconnect(
              `Security failure: ${
                typeof detail === "string" ? detail : JSON.stringify(detail)
              }`,
              false,
            );
          }}
          onCredentialsRequired={() => {
            setStatus("error");
            setLastError("VNC credentials required (not provided)");
          }}
          style={{ width: "100%", height: "100%" }}
        />
      )}
      <div className="mt-2 text-xs text-gray-500">
        <span>VNC status: {status}</span>
        {lastError && (
          <span className="ml-2 text-red-500">Error: {lastError}</span>
        )}
        {attempt > 0 && status !== "connected" && (
          <span className="ml-2">
            Retry attempt {attempt}/{MAX_RETRIES}
          </span>
        )}
      </div>
    </div>
  );
}
