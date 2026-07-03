import { useEffect, useState } from 'react';
import { Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AgentFeed } from '@/components/AgentFeed';
import { useAgentRun } from '@/hooks/useAgentRun';
import { useServers } from '@/hooks/useServers';

const ALL = '__all__';

export function ChatPanel() {
  const { servers } = useServers();
  const [model, setModel] = useState('');
  const [input, setInput] = useState('');
  const [target, setTarget] = useState<string>(ALL);
  const {
    feed,
    running,
    error,
    approval,
    start,
    cancel,
    respondApproval,
  } = useAgentRun();

  useEffect(() => {
    window.easyhost.agent.model().then(setModel).catch(() => {});
  }, []);

  async function send() {
    const text = input.trim();
    if (!text || running) return;
    setInput('');
    const serverIds = target === ALL ? undefined : [target];
    await start(
      {
        messages: [{ role: 'user', content: text }],
        serverIds,
      },
      text,
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">AI Agent</h1>
          <p className="text-xs text-muted-foreground">
            Full-auto DevOps · {model || 'model'}
          </p>
        </div>
        <div className="w-56">
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All servers</SelectItem>
              {servers.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <AgentFeed
        feed={feed}
        error={error}
        approval={approval}
        onApprove={respondApproval}
      />

      <form
        className="flex gap-2 border-t p-4"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. install nginx and host a hello-world page"
          disabled={running}
          autoFocus
        />
        {running ? (
          <Button type="button" variant="destructive" onClick={cancel}>
            <Square className="h-4 w-4" /> Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!input.trim()}>
            <Send className="h-4 w-4" /> Send
          </Button>
        )}
      </form>
    </div>
  );
}
