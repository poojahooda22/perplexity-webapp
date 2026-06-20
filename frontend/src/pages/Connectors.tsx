import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { AlertCircle, ArrowLeft, Check, Loader2, Mail, Send, Unplug } from "lucide-react";

import { supabase } from "@/lib/supabase";
import {
  gmailDisconnect,
  gmailSend,
  gmailStartUrl,
  gmailStatus,
  type GmailStatus,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// Banner shown after returning from Google's consent screen (?gmail=connected|denied|error).
const CALLBACK_BANNERS: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Gmail connected." },
  denied: { ok: false, text: "Connection cancelled — you declined the Google consent screen." },
  error: { ok: false, text: "Something went wrong connecting Gmail. Please try again." },
};

export default function Connectors() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [authChecked, setAuthChecked] = useState(false);
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  // ── Auth guard (same pattern as Dashboard) ───────────────────────────────
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

  const refreshStatus = useCallback(() => {
    setLoadingStatus(true);
    gmailStatus()
      .then(setStatus)
      .catch(() => setStatus({ connected: false }))
      .finally(() => setLoadingStatus(false));
  }, []);

  useEffect(() => {
    if (authChecked) refreshStatus();
  }, [authChecked, refreshStatus]);

  // Show the post-OAuth banner, then strip the query param so a refresh doesn't re-show it.
  useEffect(() => {
    const result = params.get("gmail");
    if (result && CALLBACK_BANNERS[result]) {
      setBanner(CALLBACK_BANNERS[result]);
      params.delete("gmail");
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConnect() {
    setConnecting(true);
    setBanner(null);
    try {
      window.location.href = await gmailStartUrl(); // leaves the app → Google consent
    } catch (e) {
      setBanner({ ok: false, text: e instanceof Error ? e.message : "Could not start connect flow." });
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    try {
      await gmailDisconnect();
      setBanner({ ok: true, text: "Gmail disconnected." });
      refreshStatus();
    } catch (e) {
      setBanner({ ok: false, text: e instanceof Error ? e.message : "Disconnect failed." });
    }
  }

  if (!authChecked) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <Link
          to="/"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back
        </Link>

        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Connectors</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Connect external accounts so the assistant can act on your behalf.
        </p>

        {banner && (
          <div
            className={`mb-5 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
              banner.ok
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            }`}
          >
            {banner.ok ? <Check className="size-4" /> : <AlertCircle className="size-4" />}
            {banner.text}
          </div>
        )}

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
                <Mail className="size-5" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-base">Gmail</CardTitle>
                <CardDescription>Send email from your Gmail account.</CardDescription>
              </div>
              <div className="ml-auto">
                {loadingStatus ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : status?.connected ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    Connected
                  </span>
                ) : (
                  <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                    Not connected
                  </span>
                )}
              </div>
            </div>
          </CardHeader>

          <CardContent>
            {loadingStatus ? null : status?.connected ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                  <span className="truncate">
                    Connected as <span className="font-medium">{status.googleEmail}</span>
                  </span>
                  <Button variant="ghost" size="sm" onClick={handleDisconnect}>
                    <Unplug className="size-4" />
                    Disconnect
                  </Button>
                </div>
                <ComposeForm />
              </div>
            ) : (
              <Button onClick={handleConnect} disabled={connecting}>
                {connecting ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
                Connect Gmail
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── Compose + send box (only rendered when Gmail is connected) ──────────────
function ComposeForm() {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleSend() {
    setSending(true);
    setResult(null);
    try {
      await gmailSend({ to: to.trim(), subject, body });
      setResult({ ok: true, text: `Sent to ${to.trim()}.` });
      setSubject("");
      setBody("");
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : "Send failed." });
    } finally {
      setSending(false);
    }
  }

  const canSend = to.trim().length > 0 && (subject.trim().length > 0 || body.trim().length > 0);

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="space-y-1.5">
        <Label htmlFor="gmail-to">To</Label>
        <Input
          id="gmail-to"
          type="email"
          placeholder="recipient@example.com"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="gmail-subject">Subject</Label>
        <Input
          id="gmail-subject"
          placeholder="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="gmail-body">Message</Label>
        <Textarea
          id="gmail-body"
          placeholder="Write your message…"
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>

      {result && (
        <div
          className={`flex items-center gap-2 text-sm ${
            result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
          }`}
        >
          {result.ok ? <Check className="size-4" /> : <AlertCircle className="size-4" />}
          {result.text}
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={handleSend} disabled={!canSend || sending}>
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          Send email
        </Button>
      </div>
    </div>
  );
}
