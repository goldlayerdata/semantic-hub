import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "../util";

// Tiny homemade DAX highlighter: comments, strings, 'table'[column], table[column], [measure], keywords, functions, numbers.
const KEYWORDS = new Set([
  "EVALUATE", "DEFINE", "MEASURE", "VAR", "RETURN", "ORDER", "BY", "ASC", "DESC", "START", "AT", "IN", "NOT", "AND", "OR",
  "TRUE", "FALSE", "COLUMN", "TABLE", "BLANK",
]);

type Tok = { t: "kw" | "fn" | "str" | "col" | "meas" | "num" | "com" | "txt"; v: string };

const RX =
  /(\/\/[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"]|"")*")|((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)\[[^\]]*\])|(\[[^\]]*\])|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w.]*)(?=\s*\()|([A-Za-z_][\w.]*)/g;

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  for (const m of src.matchAll(RX)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: "txt", v: src.slice(last, i) });
    if (m[1]) out.push({ t: "com", v: m[1] });
    else if (m[2]) out.push({ t: "str", v: m[2] });
    else if (m[3]) out.push({ t: "col", v: m[3] });
    else if (m[4]) out.push({ t: "meas", v: m[4] });
    else if (m[5]) out.push({ t: "num", v: m[5] });
    else if (m[6]) out.push({ t: KEYWORDS.has(m[6].toUpperCase()) ? "kw" : "fn", v: m[6] });
    else if (m[7]) out.push({ t: KEYWORDS.has(m[7].toUpperCase()) ? "kw" : "txt", v: m[7] });
    last = i + m[0].length;
  }
  if (last < src.length) out.push({ t: "txt", v: src.slice(last) });
  return out;
}

export function DaxCode({ code, maxHeight, copy = true, label = "DAX query" }: { code: string; maxHeight?: number; copy?: boolean; label?: string }) {
  const toks = useMemo(() => tokenize(code ?? ""), [code]);
  const [copied, setCopied] = useState(false);
  return (
    <div className="dax">
      {copy && (
        <button
          type="button"
          className="icon-btn dax-copy"
          aria-label={copied ? "Copied" : `Copy ${label}`}
          title={copied ? "Copied" : "Copy"}
          onClick={async () => {
            if (await copyText(code)) {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      )}
      <pre style={maxHeight ? { maxHeight } : undefined} tabIndex={0} aria-label={label}>
        <code>
          {toks.map((t, i) => (t.t === "txt" ? t.v : <span key={i} className={`dx-${t.t}`}>{t.v}</span>))}
        </code>
      </pre>
    </div>
  );
}
