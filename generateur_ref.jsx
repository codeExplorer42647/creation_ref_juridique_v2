import React, { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Copy, ShieldCheck, ShieldOff, History, ClipboardCheck, AlertTriangle, Download } from "lucide-react";

/**
 * Micro‑application : Générateur de références de procédure
 * Format de sortie : ^[0-9A-F]{7}[CMSIA]$
 * — 7 hex en MAJ + 1 lettre type {C,M,S,I,A}
 *
 * (1) Hypothèses / préalables
 *  - L'identifiant doit être compact, unique par procédure, sans noms/lieux visibles
 *  - Entrées utilisées (non révélées dans l'ID) : type, date ISO, juridiction, canal, compteur_local (auto), secret_salt
 *
 * (2) Cadre / modèle
 *  - Chaîne canonique v1 :  v1|{type}|{date}|{juridiction}|{canal}|{compteur_local}|{secret_salt}
 *  - HMAC‑SHA256(secret_salt, canon) → hex → 7 premiers chars, uppercased, concat type
 *  - Gestion collisions : si ID déjà alloué à un autre canon, incrémenter compteur_local, jusqu'à 5 essais
 *  - Idempotence : si le même "baseCanonical" a déjà un ID, renvoyer cet ID (stable)
 *
 * (3) Développement : voir generateId() et le store localStorage
 * (4) Conclusion : Respect du format, unicité locale, pas de fuite d'infos ; limites multi‑poste si store non partagé
 */

// ==========================
// Utilitaires généraux
// ==========================
const VERSION = "v1";
const ID_REGEX = /^[0-9A-F]{7}[CMSIA]$/;

function todayISO(): string {
  const d = new Date();
  const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return tz.toISOString().slice(0, 10); // YYYY-MM-DD
}

function toUpperHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const hexArray = [];
  for (let i = 0; i < bytes.length; i++) {
    hexArray.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return hexArray.join("").toUpperCase();
}

async function hmacSHA256_hex(keyStr: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const keyData = enc.encode(keyStr);
  const msgData = enc.encode(message);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  return toUpperHex(sig);
}

function assertTypeLetter(t: string): asserts t is "C" | "M" | "S" | "I" | "A" {
  const up = t.toUpperCase();
  if (!(["C", "M", "S", "I", "A"] as const).includes(up as any)) {
    throw new Error("Type invalide : doit être C, M, S, I ou A");
  }
}

// ==========================
// Store (localStorage)
// ==========================
// Clés LS
const LS_IDS = "hexRef:ids"; // mapping id → context
const LS_BASE_INDEX = "hexRef:baseIndex"; // mapping baseCanonical → id
const LS_COUNTERS = "hexRef:counters"; // mapping bucketKey (baseCanonical) → lastCounter (number)
const LS_HISTORY = "hexRef:history"; // tableau d'entrées
const LS_SECRET = "hexRef:secret"; // secret_salt (optionnel, si mémorisé)
const LS_REMEMBER = "hexRef:remember"; // "true"/"false"

// Types
interface InputsNorm {
  type: "C" | "M" | "S" | "I" | "A";
  date: string; // YYYY-MM-DD
  juridiction: string; // uppercase
  canal: string; // uppercase
  compteur_local: number;
  secret_salt: string;
}

interface StoredContext {
  id: string;
  baseCanonical: string; // v1|type|date|jur|canal (sans compteur ni secret)
  fullCanonical: string; // avec compteur & secret
  type: InputsNorm["type"];
  date: string;
  juridiction: string;
  canal: string;
  compteur_local: number;
  createdAt: string; // ISO datetime
}

interface HistoryEntry {
  id: string;
  type: InputsNorm["type"];
  date: string;
  juridiction: string;
  canal: string;
  createdAt: string;
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJSON<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
}

function existsId(id: string): boolean {
  const ids: Record<string, StoredContext> = readJSON(LS_IDS, {} as Record<string, StoredContext>);
  return Boolean(ids[id]);
}

function saveContext(ctx: StoredContext) {
  const ids: Record<string, StoredContext> = readJSON(LS_IDS, {} as Record<string, StoredContext>);
  ids[ctx.id] = ctx;
  writeJSON(LS_IDS, ids);

  const baseIndex: Record<string, string> = readJSON(LS_BASE_INDEX, {} as Record<string, string>);
  baseIndex[ctx.baseCanonical] = ctx.id;
  writeJSON(LS_BASE_INDEX, baseIndex);

  // History (limité à 200 entrées)
  const hist: HistoryEntry[] = readJSON(LS_HISTORY, [] as HistoryEntry[]);
  hist.unshift({ id: ctx.id, type: ctx.type, date: ctx.date, juridiction: ctx.juridiction, canal: ctx.canal, createdAt: ctx.createdAt });
  if (hist.length > 200) hist.length = 200;
  writeJSON(LS_HISTORY, hist);
}

function getIdByBase(baseCanonical: string): string | null {
  const baseIndex: Record<string, string> = readJSON(LS_BASE_INDEX, {} as Record<string, string>);
  return baseIndex[baseCanonical] || null;
}

function getLastCounter(baseCanonical: string): number {
  const counters: Record<string, number> = readJSON(LS_COUNTERS, {} as Record<string, number>);
  return Number.isInteger(counters[baseCanonical]) ? counters[baseCanonical] : 0;
}

function bumpCounter(baseCanonical: string, newValue: number) {
  const counters: Record<string, number> = readJSON(LS_COUNTERS, {} as Record<string, number>);
  counters[baseCanonical] = newValue;
  writeJSON(LS_COUNTERS, counters);
}

function getStoredSecret(): string | null {
  const remember = localStorage.getItem(LS_REMEMBER) === "true";
  if (!remember) return null;
  const s = localStorage.getItem(LS_SECRET);
  return s && s.length > 0 ? s : null;
}

function setStoredSecret(secret: string | null, remember: boolean) {
  localStorage.setItem(LS_REMEMBER, remember ? "true" : "false");
  if (remember && secret) {
    localStorage.setItem(LS_SECRET, secret);
  } else {
    localStorage.removeItem(LS_SECRET);
  }
}

// ==========================
// Génération de l'ID
// ==========================
function normalizeInputs(raw: { type: string; date?: string; juridiction?: string; canal?: string; secret_salt: string; }): InputsNorm {
  const t = raw.type.toUpperCase();
  assertTypeLetter(t);

  const date = (raw.date && /\d{4}-\d{2}-\d{2}/.test(raw.date)) ? raw.date : todayISO();
  const juridiction = (raw.juridiction || "").trim().toUpperCase();
  const canal = (raw.canal || "WEB").trim().toUpperCase();
  const secret_salt = (raw.secret_salt || "").toString();
  if (!secret_salt) throw new Error("Le secret (secret_salt) est requis.");

  const baseCanonical = `${VERSION}|${t}|${date}|${juridiction}|${canal}`;
  const last = getLastCounter(baseCanonical);

  return { type: t, date, juridiction, canal, compteur_local: last, secret_salt } as InputsNorm;
}

function baseCanonicalOf(inp: Pick<InputsNorm, "type" | "date" | "juridiction" | "canal">): string {
  return `${VERSION}|${inp.type}|${inp.date}|${inp.juridiction}|${inp.canal}`;
}

function fullCanonicalOf(inp: InputsNorm): string {
  return `${VERSION}|${inp.type}|${inp.date}|${inp.juridiction}|${inp.canal}|${inp.compteur_local}|${inp.secret_salt}`;
}

async function generateId(rawInputs: { type: string; date?: string; juridiction?: string; canal?: string; secret_salt: string; }): Promise<string> {
  // Normaliser et préparer
  let inputs = normalizeInputs(rawInputs);
  const baseCanonical = baseCanonicalOf(inputs);

  // Idempotence : si déjà généré pour ce baseCanonical, renvoyer l'ID existant
  const existing = getIdByBase(baseCanonical);
  if (existing) {
    return existing;
  }

  // Tentatives avec collision handling (au plus 5)
  for (let tries = 0; tries <= 5; tries++) {
    const canonical = fullCanonicalOf(inputs);
    const digestHex = await hmacSHA256_hex(inputs.secret_salt, canonical);
    const hex7 = digestHex.slice(0, 7).toUpperCase();
    const id = `${hex7}${inputs.type}`;

    if (!ID_REGEX.test(id)) {
      throw new Error("ID généré invalide (format)");
    }

    // Collision ?
    if (!existsId(id)) {
      // Sauver contexte, bump le compteur pour la prochaine génération
      const ctx: StoredContext = {
        id,
        baseCanonical,
        fullCanonical: canonical,
        type: inputs.type,
        date: inputs.date,
        juridiction: inputs.juridiction,
        canal: inputs.canal,
        compteur_local: inputs.compteur_local,
        createdAt: new Date().toISOString(),
      };
      saveContext(ctx);
      bumpCounter(baseCanonical, inputs.compteur_local + 1);
      return id;
    } else {
      // ID déjà existant. Vérifier si c'est la même procédure (même canonical complet)
      const ids: Record<string, StoredContext> = readJSON(LS_IDS, {} as Record<string, StoredContext>);
      const found = ids[id];
      if (found && found.fullCanonical === canonical) {
        // Même entrée → idempotent
        return id;
      }
      // Sinon collision → incrémenter compteur et retenter
      inputs.compteur_local++;
    }
  }
  throw new Error("Collision non résolue après 6 tentatives");
}

// ==========================
// UI
// ==========================
export default function HexRefApp() {
  const [type, setType] = useState<"C" | "M" | "S" | "I" | "A">("M");
  const [date, setDate] = useState<string>(todayISO());
  const [jur, setJur] = useState<string>("CH-BL");
  const [canal, setCanal] = useState<string>("WEB");
  const [secret, setSecret] = useState<string>("");
  const [remember, setRemember] = useState<boolean>(false);

  const [result, setResult] = useState<string>("");
  const [status, setStatus] = useState<"idle" | "working" | "ok" | "error">("idle");
  const [error, setError] = useState<string>("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    // Charger secret mémorisé + historique
    const s = getStoredSecret();
    if (s) {
      setSecret(s);
      setRemember(true);
    }
    setHistory(readJSON<HistoryEntry[]>(LS_HISTORY, []));
  }, []);

  function reset() {
    setResult("");
    setStatus("idle");
    setError("");
  }

  async function onGenerate() {
    setStatus("working");
    setError("");
    try {
      const id = await generateId({ type, date, juridiction: jur, canal, secret_salt: secret });
      setResult(id);
      setStatus("ok");
      // refresh history
      setHistory(readJSON<HistoryEntry[]>(LS_HISTORY, []));
      // mémorisation secret si demandé
      setStoredSecret(secret, remember);
    } catch (e: any) {
      setStatus("error");
      setError(e?.message || String(e));
    }
  }

  async function copyToClipboard() {
    if (!result) return;
    await navigator.clipboard.writeText(result);
    setStatus("ok");
  }

  const canGenerate = useMemo(() => {
    return (
      secret.trim().length > 0 &&
      ["C", "M", "S", "I", "A"].includes(type) &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      jur.trim().length > 0 &&
      canal.trim().length > 0
    );
  }, [secret, type, date, jur, canal]);

  function exportCSV() {
    const rows = [
      ["id", "type", "date", "juridiction", "canal", "createdAt"],
      ...history.map(h => [h.id, h.type, h.date, h.juridiction, h.canal, h.createdAt])
    ];
    const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hexref_history_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white text-slate-900 p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <Card className="shadow-lg border border-slate-200">
          <CardHeader>
            <CardTitle className="text-2xl font-semibold flex items-center gap-3">
              Générateur de références HEX (7+1)
              {status === "ok" ? <ClipboardCheck className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Type de procédure</Label>
                <Select value={type} onValueChange={(v) => setType(v as any)}>
                  <SelectTrigger className="">
                    <SelectValue placeholder="Choisir un type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="C">C — Civil / Responsabilité</SelectItem>
                    <SelectItem value="M">M — Médical / Santé</SelectItem>
                    <SelectItem value="S">S — Successoral / Héritage</SelectItem>
                    <SelectItem value="I">I — Immobilier</SelectItem>
                    <SelectItem value="A">A — Académique / Étudiant</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Date (ISO)</Label>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Juridiction (code interne)</Label>
                <Input placeholder="CH-BL / ES-LE / ..." value={jur} onChange={(e) => setJur(e.target.value.toUpperCase())} />
              </div>
              <div className="space-y-2">
                <Label>Canal</Label>
                <Input placeholder="WEB / CLI / MOBILE" value={canal} onChange={(e) => setCanal(e.target.value.toUpperCase())} />
              </div>
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-2">Secret (secret_salt)
                {remember ? <ShieldCheck className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
              </Label>
              <Input type="password" placeholder="Saisir le secret..." value={secret} onChange={(e) => setSecret(e.target.value)} />
              <div className="flex items-center gap-2">
                <Switch id="remember" checked={remember} onCheckedChange={(v) => setRemember(Boolean(v))} />
                <Label htmlFor="remember">Mémoriser localement le secret (optionnel)</Label>
              </div>
              <p className="text-sm text-slate-500 flex items-start gap-2"><AlertTriangle className="w-4 h-4 mt-0.5"/> Le secret n'est jamais inclus dans l'ID ; il sert uniquement au HMAC. En environnement partagé, ne le mémorisez pas.</p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={onGenerate} disabled={!canGenerate || status === "working"}>
                {status === "working" ? "Génération..." : "Générer la référence"}
              </Button>
              <Button variant="secondary" onClick={copyToClipboard} disabled={!result}>Copier</Button>
              <Button variant="outline" onClick={exportCSV} disabled={history.length === 0} className="flex items-center gap-2"><Download className="w-4 h-4"/>Exporter l'historique (CSV)</Button>
            </div>

            <div className="mt-2">
              <Label>Référence générée</Label>
              <Textarea readOnly value={result || ""} placeholder="—" className="font-mono text-lg tracking-widest h-16" />
              <p className="text-xs text-slate-500 mt-1">Format garanti : <span className="font-mono">^[0-9A-F]{7}[CMSIA]$</span></p>
            </div>

            {status === "error" && (
              <div className="text-red-600 text-sm font-medium">Erreur : {error}</div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow border border-slate-200">
          <CardHeader>
            <CardTitle className="text-xl flex items-center gap-2"><History className="w-5 h-5"/> Historique (local)</CardTitle>
          </CardHeader>
          <CardContent>
            {history.length === 0 ? (
              <p className="text-sm text-slate-500">Aucune référence encore générée.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b">
                      <th className="py-2">ID</th>
                      <th className="py-2">Type</th>
                      <th className="py-2">Date</th>
                      <th className="py-2">Juridiction</th>
                      <th className="py-2">Canal</th>
                      <th className="py-2">Créé le</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h, i) => (
                      <tr key={h.id + i} className="border-b last:border-0">
                        <td className="py-2 font-mono">{h.id}</td>
                        <td className="py-2">{h.type}</td>
                        <td className="py-2">{h.date}</td>
                        <td className="py-2">{h.juridiction}</td>
                        <td className="py-2">{h.canal}</td>
                        <td className="py-2">{new Date(h.createdAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow border border-slate-200">
          <CardHeader>
            <CardTitle className="text-lg">Détails techniques (résumé)</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-slate-700 space-y-2">
            <p><strong>Chaîne canonique</strong> : <span className="font-mono">{VERSION}|&#123;type&#125;|&#123;date&#125;|&#123;juridiction&#125;|&#123;canal&#125;|&#123;compteur_local&#125;|&#123;secret_salt&#125;</span></p>
            <p><strong>Hachage</strong> : HMAC‑SHA256(secret, canon) → hex → 7 premiers → + lettre type.</p>
            <p><strong>Idempotence</strong> : si le même <span className="font-mono">{VERSION}|type|date|jur|canal</span> a déjà un ID, on renvoie l'ID existant.</p>
            <p><strong>Unicité locale</strong> : compteur local par couple (type, date, juridiction, canal). Collisions rares, mais gérées par incrément.</p>
            <p><strong>Limites</strong> : en multi‑poste sans backend partagé, l'unicité n'est garantie que par instance.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
