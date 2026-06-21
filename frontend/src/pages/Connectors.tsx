import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useSearchParams } from "react-router";
import { motion } from "motion/react";
import {
  AlertCircle,
  ArrowLeft,
  Box,
  Check,
  FileText,
  Loader2,
  Mail,
  MessageSquare,
  Plus,
  Send,
  ShieldCheck,
  TrendingUp,
  Unplug,
  X,
} from "lucide-react";
import type { ComponentType } from "react";

import { supabase } from "@/lib/supabase";
import { gmailStartUrl } from "@/lib/api";
import { useGmailDisconnect, useGmailSend, useGmailStatus } from "@/hooks/use-connectors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type IconType = ComponentType<{ className?: string }>;
type ConnectorState = "available" | "builtin" | "soon";

interface ConnectorTool {
  name: string;
  desc: string;
}
interface ConnectorDef {
  id: string;
  name: string;
  description: string;
  icon: IconType;
  tint: string; // tailwind classes for the icon chip
  state: ConnectorState;
  overview: string[];
  tools: ConnectorTool[];
}

// The connector catalog. Gmail is the real, connectable one; Finance is our built-in agent
// (already shipped); the rest are clearly-labelled "Soon" so the grid reads like a real
// product roadmap, not filler.
const CONNECTORS: ConnectorDef[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Send email from your Gmail account.",
    icon: Mail,
    tint: "bg-red-500/10 text-red-600 dark:text-red-400",
    state: "available",
    overview: [
      "Compose and send email as your connected Gmail address",
      "Send-only access — Lumina never reads your inbox",
      "Every send is confirmed by you before it goes out",
    ],
    tools: [{ name: "Send an email", desc: "Compose and send an email from your Gmail account." }],
  },
  // {
  //   id: "finance",
  //   name: "Lumina Finance",
  //   description: "Built-in live market tools.",
  //   icon: TrendingUp,
  //   tint: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  //   state: "builtin",
  //   overview: [
  //     "Live stock, index, and crypto quotes",
  //     "Finance web search for news and context",
  //     "Always on — no setup required",
  //   ],
  //   tools: [
  //     { name: "Get quote", desc: "Latest price + daily move for US stocks/ETFs." },
  //     { name: "Get crypto", desc: "Price, 24h change, and market cap by coin." },
  //     { name: "Get indices", desc: "S&P 500, NASDAQ, Dow, and the VIX." },
  //     { name: "Finance web search", desc: "News, earnings, and macro context." },
  //   ],
  // },
  {
    id: "outlook",
    name: "Outlook",
    description: "Send and search Outlook email.",
    icon: Mail,
    tint: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    state: "soon",
    overview: [],
    tools: [],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Post and read Slack messages.",
    icon: MessageSquare,
    tint: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    state: "soon",
    overview: [],
    tools: [],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Read and update Notion pages.",
    icon: FileText,
    tint: "bg-foreground/10 text-foreground",
    state: "soon",
    overview: [],
    tools: [],
  },
  {
    id: "github",
    name: "GitHub",
    description: "Search repos, issues, and PRs.",
    icon: Box,
    tint: "bg-foreground/10 text-foreground",
    state: "soon",
    overview: [],
    tools: [],
  },
];

// Post-OAuth banner (?gmail=connected|denied|error).
const CALLBACK_BANNERS: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Gmail connected." },
  denied: { ok: false, text: "Connection cancelled — you declined the Google consent screen." },
  error: { ok: false, text: "Something went wrong connecting Gmail. Please try again." },
};

export default function Connectors() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [authChecked, setAuthChecked] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  const status = useGmailStatus();

  // ── Auth guard (same as Dashboard) ───────────────────────────────────────
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (!data.session) navigate("/auth");
      else setAuthChecked(true);
    });
    return () => {
      active = false;
    };
  }, [navigate]);

  // Show the post-OAuth banner once, then strip the query param.
  useEffect(() => {
    const result = params.get("gmail");
    if (result && CALLBACK_BANNERS[result]) {
      setBanner(CALLBACK_BANNERS[result]);
      params.delete("gmail");
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!authChecked) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const gmailConnected = !!status.data?.connected;
  const openDef = CONNECTORS.find((c) => c.id === openId) ?? null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <Link
          to="/"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back
        </Link>

        <h1 className="text-2xl font-semibold tracking-tight">Connectors</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect services so Lumina can act on your behalf.
        </p>

        {banner && (
          <div
            className={cn(
              "mt-5 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
              banner.ok
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-destructive/30 bg-destructive/10 text-destructive",
            )}
          >
            {banner.ok ? <Check className="size-4" /> : <AlertCircle className="size-4" />}
            {banner.text}
          </div>
        )}

        <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CONNECTORS.map((c) => (
            <ConnectorCard
              key={c.id}
              def={c}
              connected={c.id === "gmail" && gmailConnected}
              onOpen={() => c.state !== "soon" && setOpenId(c.id)}
            />
          ))}
        </div>
      </div>

      {openDef && (
        <ConnectorModal
          def={openDef}
          gmailConnected={gmailConnected}
          gmailEmail={status.data?.googleEmail}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

// ── Connector card ──────────────────────────────────────────────────────────
function ConnectorCard({
  def,
  connected,
  onOpen,
}: {
  def: ConnectorDef;
  connected: boolean;
  onOpen: () => void;
}) {
  const soon = def.state === "soon";
  const Icon = def.icon;

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={soon}
      className={cn(
        "group flex items-start gap-3 rounded-xl border bg-card p-4 text-left transition-colors",
        soon
          ? "cursor-not-allowed opacity-60"
          : "hover:border-ring/50 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
      )}
    >
      <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", def.tint)}>
        <Icon className="size-5" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{def.name}</span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{def.description}</p>
      </div>

      <div className="shrink-0 self-center">
        {connected ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <Check className="size-3" />
            Connected
          </span>
        ) : def.state === "builtin" ? (
          <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
            Built-in
          </span>
        ) : soon ? (
          <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
            Soon
          </span>
        ) : (
          <span className="inline-flex size-7 items-center justify-center rounded-full border text-muted-foreground transition-colors group-hover:border-ring/50 group-hover:text-foreground">
            <Plus className="size-4" />
          </span>
        )}
      </div>
    </button>
  );
}

// ── Detail modal ──────────────────────────────────────────────────────────
function ConnectorModal({
  def,
  gmailConnected,
  gmailEmail,
  onClose,
}: {
  def: ConnectorDef;
  gmailConnected: boolean;
  gmailEmail?: string;
  onClose: () => void;
}) {
  const Icon = def.icon;
  const isGmail = def.id === "gmail";
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disconnect = useGmailDisconnect();

  // Lock scroll + close on Escape while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  async function handleConnect() {
    setConnecting(true);
    setError(null);
    try {
      window.location.href = await gmailStartUrl(); // leaves the app → Google consent
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the connect flow.");
      setConnecting(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b p-5">
          <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", def.tint)}>
            <Icon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{def.name}</h2>
            <p className="text-sm text-muted-foreground">{def.description}</p>
          </div>
          {isGmail &&
            (gmailConnected ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => disconnect.mutate()}
                disabled={disconnect.isPending}
              >
                {disconnect.isPending ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}
                Disconnect
              </Button>
            ) : (
              <Button size="sm" onClick={handleConnect} disabled={connecting}>
                {connecting ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                Connect
              </Button>
            ))}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-1 inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="size-4" />
              {error}
            </div>
          )}

          {isGmail && gmailConnected && (
            <div className="mb-5 flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
              Connected as <span className="font-medium">{gmailEmail}</span>
            </div>
          )}

          {def.overview.length > 0 && (
            <div className="mb-6">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Overview
              </h3>
              <ul className="space-y-1.5">
                {def.overview.map((line) => (
                  <li key={line} className="flex items-start gap-2 text-sm text-foreground">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {def.tools.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Tools
              </h3>
              <div className="divide-y rounded-lg border">
                {def.tools.map((t) => (
                  <div key={t.name} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{t.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{t.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Compose / test-send appears only when Gmail is connected. */}
          {isGmail && gmailConnected && <GmailCompose />}
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

// ── Compose + send box (only when Gmail is connected) ───────────────────────
function GmailCompose() {
  const send = useGmailSend();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const canSend = to.trim().length > 0 && (subject.trim().length > 0 || body.trim().length > 0);

  function handleSend() {
    setResult(null);
    send.mutate(
      { to: to.trim(), subject, body },
      {
        onSuccess: () => {
          setResult({ ok: true, text: `Sent to ${to.trim()}.` });
          setSubject("");
          setBody("");
        },
        onError: (e) => setResult({ ok: false, text: e instanceof Error ? e.message : "Send failed." }),
      },
    );
  }

  return (
    <div className="mt-6 space-y-3 border-t pt-5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Send a test email
      </h3>
      <div className="space-y-1.5">
        <Label htmlFor="gmail-to">To</Label>
        <Input id="gmail-to" type="email" placeholder="recipient@example.com" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="gmail-subject">Subject</Label>
        <Input id="gmail-subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="gmail-body">Message</Label>
        <Textarea id="gmail-body" rows={5} placeholder="Write your message…" value={body} onChange={(e) => setBody(e.target.value)} />
      </div>

      {result && (
        <div
          className={cn(
            "flex items-center gap-2 text-sm",
            result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
          )}
        >
          {result.ok ? <Check className="size-4" /> : <AlertCircle className="size-4" />}
          {result.text}
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={handleSend} disabled={!canSend || send.isPending}>
          {send.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          Send email
        </Button>
      </div>
    </div>
  );
}
