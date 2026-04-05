"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState, useEffect } from "react";
import { Bot, Wifi, WifiOff } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import { Suggestions, Suggestion } from "@/components/ai-elements/suggestion";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning";
import { Badge } from "@/components/ui/badge";

export default function Page() {
  const [extensionConnected, setExtensionConnected] = useState(false);

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
    }),
  });

  const isStreaming = status === "streaming";

  // Poll extension status from bridge
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch("/api/extension-status");
        const data = await res.json();
        setExtensionConnected(data.extension);
      } catch {
        setExtensionConnected(false);
      }
    };
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Toon Squad</h1>
          <Badge
            variant={extensionConnected ? "default" : "destructive"}
            className="gap-1 text-xs"
          >
            {extensionConnected ? (
              <Wifi className="h-3 w-3" />
            ) : (
              <WifiOff className="h-3 w-3" />
            )}
            {extensionConnected ? "Extension" : "No Extension"}
          </Badge>
        </div>
      </header>

      {/* Chat */}
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto max-w-3xl">
          {messages.length === 0 && (
            <ConversationEmptyState
              icon={<Bot className="h-8 w-8" />}
              title="Welcome to Toon Squad"
              description="I can control your Chrome browser — navigate sites, read pages, click elements, and fill forms using your logged-in sessions."
            />
          )}

          {messages.map((message) => (
            <Message key={message.id} from={message.role}>
              <MessageContent>
                {message.parts.map((part, i) => {
                  if (part.type === "text") {
                    return (
                      <MessageResponse
                        key={i}
                        isAnimating={
                          isStreaming &&
                          message.id === messages[messages.length - 1]?.id
                        }
                      >
                        {part.text}
                      </MessageResponse>
                    );
                  }

                  if (part.type === "reasoning") {
                    const reasoningPart = part as { type: string; text: string };
                    return (
                      <Reasoning key={i} isStreaming={isStreaming && message.id === messages[messages.length - 1]?.id}>
                        <ReasoningTrigger />
                        <ReasoningContent>{reasoningPart.text}</ReasoningContent>
                      </Reasoning>
                    );
                  }

                  // Tool parts (tool-navigate, tool-list_tabs, etc.)
                  if (part.type.startsWith("tool-")) {
                    const toolPart = part as {
                      type: string;
                      toolCallId: string;
                      state: string;
                      toolName?: string;
                      input?: unknown;
                      output?: unknown;
                      errorText?: string;
                    };
                    const name =
                      toolPart.toolName ?? part.type.replace("tool-", "");
                    return (
                      <Tool key={i}>
                        <ToolHeader
                          type={part.type as `tool-${string}`}
                          state={toolPart.state as any}
                          title={name}
                        />
                        <ToolContent>
                          {toolPart.input && (
                            <ToolInput input={toolPart.input} />
                          )}
                          {(toolPart.output || toolPart.errorText) && (
                            <ToolOutput
                              output={toolPart.output}
                              errorText={toolPart.errorText}
                            />
                          )}
                        </ToolContent>
                      </Tool>
                    );
                  }

                  return null;
                })}
              </MessageContent>
            </Message>
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Input */}
      <div className="border-t px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {messages.length === 0 && (
            <Suggestions className="mb-3">
              <Suggestion suggestion="List all my open tabs" onClick={(s) => sendMessage({ text: s })} />
              <Suggestion suggestion="Navigate to Wikipedia" onClick={(s) => sendMessage({ text: s })} />
              <Suggestion suggestion="What's on my active tab?" onClick={(s) => sendMessage({ text: s })} />
              <Suggestion suggestion="Search Google for today's news" onClick={(s) => sendMessage({ text: s })} />
            </Suggestions>
          )}
          <PromptInput
            onSubmit={(message) => {
              sendMessage({ text: message.text });
            }}
          >
            <PromptInputTextarea
              placeholder="Ask me to browse a website, read a page, or interact with any site..."
              disabled={status !== "ready"}
            />
            <PromptInputSubmit disabled={status !== "ready"} />
          </PromptInput>
        </div>
      </div>
    </div>
  );
}
