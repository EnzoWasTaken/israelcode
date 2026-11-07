import type { SkillFile } from "./skill-finder.js";
import {
  SKILL_SCAN_PATTERNS,
  findHideFromUser,
  isExfilUrl,
  isSuspiciousSkillInstallUrl,
  skillHostOf,
  skillUrlsIn,
  splitSkillLines,
  type SkillFileKind,
  type SkillLogicalLine,
} from "./skill-scan.js";

/**
 * Install-time security scan for a skill snapshot (gg-safe S1, install side).
 *
 * Unlike `skill-scan.ts` (load time: first hit refuses the skill, silently),
 * this reports EVERY finding with a severity so the user can see what was
 * found before deciding. Pure: it reads the snapshot's files in memory and
 * never executes, requires or writes anything.
 *
 * Verdict: any critical/high finding → "block"; medium → "warn"; else "pass".
 *
 * Markdown keeps the load-time scanner's instruct-vs-describe logic: prose
 * that warns or analyses ("never", "attack", "e.g.") under a non-imperative
 * heading is not a hit; imperative setup/prerequisite sections and fenced
 * code blocks are. Script files get no allowance — code runs. Text rules run
 * on NFKC-normalised text; the hidden-character rules (HID-03..07) run on the
 * raw text so normalisation can't erase what they look for.
 */

export type InstallScanSeverity = "critical" | "high" | "medium" | "low";

export interface InstallScanFinding {
  /** Rule id from the catalogue, e.g. "EXE-01". */
  rule: string;
  /** Plain words: what the rule looks for. */
  title: string;
  severity: InstallScanSeverity;
  /** Path relative to the skill folder, forward slashes. */
  file: string;
  /** 1-based line, 0 when not line-specific. */
  line: number;
  /** Plain words: why this line matched. */
  reason: string;
  /** The matched text, trimmed to ~160 chars. */
  evidence?: string;
}

export type InstallScanVerdict = "pass" | "warn" | "block";

export interface InstallScanResult {
  verdict: InstallScanVerdict;
  findings: InstallScanFinding[];
  /** One line for the UI banner, e.g. "2 blocking findings, 1 warning". */
  summary: string;
  /** How many rules ran, for the "scanned with N rules" note. */
  rulesRun: number;
}

export function verdictFor(findings: readonly InstallScanFinding[]): InstallScanVerdict {
  if (findings.some((f) => f.severity === "critical" || f.severity === "high")) return "block";
  if (findings.some((f) => f.severity === "medium")) return "warn";
  return "pass";
}

export function summarizeFindings(findings: readonly InstallScanFinding[]): string {
  const blocking = findings.filter(
    (f) => f.severity === "critical" || f.severity === "high",
  ).length;
  const warnings = findings.filter((f) => f.severity === "medium").length;
  const notes = findings.filter((f) => f.severity === "low").length;
  if (findings.length === 0) return "No findings";
  const parts: string[] = [];
  if (blocking) parts.push(`${blocking} blocking finding${blocking === 1 ? "" : "s"}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  if (notes) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
  return parts.join(", ");
}

// ── Rule catalogue ──────────────────────────────────────────────────────────

interface RuleDef {
  title: string;
  severity: InstallScanSeverity;
}

/** Every rule the scanner runs, with its default severity (a hit may lower it). */
export const INSTALL_SCAN_RULES: Readonly<Record<string, RuleDef>> = {
  "INJ-01": { title: "Overrides the agent's instructions", severity: "critical" },
  "INJ-02": { title: "Tells the agent to hide actions from the user", severity: "critical" },
  "INJ-03": { title: "Fake system or tool message", severity: "high" },
  "INJ-04": { title: "Role hijack / jailbreak persona", severity: "medium" },
  "INJ-05": { title: "Disables agent safety controls", severity: "high" },
  "INJ-06": { title: "Agent-directed text in the skill description", severity: "medium" },
  "INJ-07": { title: "Instructs the agent to send secrets away", severity: "high" },
  "INJ-08": { title: "Fake prerequisite / terminal lure", severity: "high" },
  "HID-01": { title: "Instructions hidden in HTML comments", severity: "high" },
  "HID-02": { title: "Text hidden with CSS or whitespace padding", severity: "high" },
  "HID-03": { title: "Unicode tag characters (invisible text)", severity: "critical" },
  "HID-04": { title: "Zero-width / invisible characters", severity: "medium" },
  "HID-05": { title: "Variation-selector smuggling", severity: "high" },
  "HID-06": { title: "Bidirectional control characters", severity: "high" },
  "HID-07": { title: "Terminal escape / control characters", severity: "high" },
  "EXE-01": { title: "Downloads a script and pipes it into a shell", severity: "critical" },
  "EXE-02": { title: "Downloads a file, then makes it executable or runs it", severity: "high" },
  "EXE-03": { title: "Decodes encoded text and runs it", severity: "critical" },
  "EXE-04": { title: "Encoded payload decodes to flagged content", severity: "critical" },
  "EXE-05": { title: "Password-protected archive (scanner evasion)", severity: "high" },
  "EXE-06": { title: "Reverse shell", severity: "critical" },
  "EXE-07": { title: "Obfuscated or packed script", severity: "high" },
  "EXE-08": { title: "Fake password prompt", severity: "critical" },
  "CRED-01": { title: "Reads credential stores", severity: "high" },
  "CRED-02": { title: "Reads config/token files", severity: "medium" },
  "CRED-03": { title: "Dumps environment or mints tokens", severity: "medium" },
  "CRED-04": { title: "Hardcoded secret", severity: "medium" },
  "NET-01": { title: "Exfiltration-prone endpoint", severity: "high" },
  "NET-02": { title: "Raw IP address or plain-HTTP download", severity: "medium" },
  "NET-03": { title: "Credential read and network call together", severity: "critical" },
  "PERS-01": { title: "Persistence (startup, cron, shell rc)", severity: "high" },
  "PERS-02": { title: "Tampers with agent config or instructions", severity: "medium" },
  "DEST-01": { title: "Destructive or privilege-escalating command", severity: "critical" },
  "PKG-01": { title: "Packaging / structure risk", severity: "medium" },
};

const RULE_COUNT = Object.keys(INSTALL_SCAN_RULES).length;

// ── File kinds ──────────────────────────────────────────────────────────────

const MARKDOWN_EXTS = new Set([".md", ".mdx", ".markdown", ".html", ".htm", ".txt"]);
const MAX_FILE_CHARS = 1024 * 1024;

function extOf(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot).toLowerCase();
}

function kindOf(file: string): SkillFileKind {
  return MARKDOWN_EXTS.has(extOf(file)) ? "markdown" : "script";
}

function isSkillMd(file: string): boolean {
  return /(?:^|\/)SKILL\.md$/i.test(file);
}

// ── Shared vocabulary ───────────────────────────────────────────────────────

const HAS_URL = /https?:\/\//i;
const NET_CALL =
  /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|fetch\s*\(|requests\.(?:get|post|put)|urllib|http\.client|axios|XMLHttpRequest|WebClient|DownloadString|UploadString|nslookup|dig\s|nc|ncat|socket\.socket|net\.Dial|scp|rsync|sftp)\b/i;
const READ_VERB =
  /\b(?:cat|less|more|head|tail|type|Get-Content|gc|read|source|base64|xxd|strings|cp|scp|rsync|tar|zip|7z|open|readFile\w*|read_text|readlines|load|import|include|upload|send|post|curl|wget|print|echo)\b/i;

// INJ
const INJ_OVERRIDE: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|of\s+your\s+)?(?:previous|prior|above|earlier|preceding|system|original|existing)\s+(?:\w+\s+)?(?:instructions?|prompts?|rules?|guidelines?|directives?|constraints?|guidance)\b/i,
  /\bforget\s+(?:all\s+(?:of\s+)?)?your\s+(?:rules|instructions|guidelines|training)\b/i,
  /\byour\s+(?:new|real|true|actual)\s+(?:instructions?|task|purpose|goal)\s+(?:is|are)\b/i,
];
const INJ_CONCEAL_EXTRA: RegExp[] = [
  /\bwithout\s+(?:the\s+)?user(?:'s)?\s+(?:knowing|knowledge|noticing|awareness|consent|approval)\b/i,
  /\bdo\s+not\s+(?:tell|mention|show|inform|alert|notify)\s+the\s+user\b/i,
];
const INJ_FAKE_SYSTEM =
  /<\/?(?:system|system-reminder|system_reminder|tool_result|function_results|function_calls|antml:[a-z_]+)\s*>|\[(?:SYSTEM|INST|\/INST)\]|<\|(?:im_start|im_end|system|endoftext|user|assistant)\|>|^\s*(?:SYSTEM|System)\s*:\s+(?:you|ignore|override)/i;
const INJ_ROLE_HIJACK: RegExp[] = [
  /\byou\s+are\s+now\s+(?:DAN|an?\s+(?:unrestricted|unfiltered|uncensored|jailbroken)|free\s+(?:of|from)|in\s+developer\s+mode|jailbroken)\b/i,
  /\b(?:enable|enter|activate|switch\s+to)\s+(?:developer|DAN|god|jailbreak)\s+mode\b/i,
  /\bDAN\s+mode\b|\bdo\s+anything\s+now\b/i,
  /\bno\s+(?:longer\s+)?(?:bound|restricted|limited)\s+by\s+(?:any\s+)?(?:rules|guidelines|policies|restrictions|ethics|safety)\b/i,
  /\bpretend\s+(?:that\s+)?you\s+(?:have|are)\s+no\s+(?:restrictions|rules|guidelines|limits)\b/i,
];
const INJ_DISABLE_SAFETY =
  /--dangerously-skip-permissions\b|--dangerously-bypass-approvals-and-sandbox\b|\bbypassPermissions\b|\bdisableAllHooks\b|--yolo\b|\bdisableSkillShellExecution\W{0,5}false\b|\bskipDangerousModePermissionPrompt\b|\b(?:disable|turn\s+off|skip)\s+(?:all\s+)?(?:the\s+)?(?:permission\s+(?:checks?|prompts?)|safety\s+(?:checks?|guardrails?|hooks?)|guardrails)\b/i;
const INJ_DESCRIPTION =
  /\b(?:ignore|disregard)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|other|above|earlier)\b|\balways\s+(?:use|invoke|load|prefer)\s+this\s+skill\b|\bmust\s+(?:always\s+)?(?:use|invoke|load|run)\s+this\b|<\/?[a-z][a-z_-]*>|\b(?:use|prefer)\s+this\s+(?:skill\s+)?(?:over|instead\s+of|before)\s+(?:all|any|every|other)\b|\bfor\s+(?:all|every|any)\s+(?:task|request|prompt)s?\b/i;
const INJ_SEND_VERB =
  /\b(?:send|post|upload|transmit|submit|forward|exfiltrate|share|push|mail|email)\b/i;
const CREDENTIAL_WORDS =
  /\b(?:credentials?|ssh\s+keys?|private\s+keys?|\.env\s+file|env\s+file|environment\s+variables?|keychain|api[\s_-]?keys?|access\s+tokens?|auth\s+tokens?|secrets?|passwords?)\b/i;
const PASTE_LURE =
  /\b(?:copy\s+(?:and|&|\/)\s+)?paste\b[^\n]{0,80}\b(?:into|in|to)\s+(?:your\s+|the\s+|a\s+)?(?:terminal|shell|console|powershell|command\s+(?:prompt|line)|cmd)\b/i;
const INSTALL_VERB = /\b(?:download|install|run|open|execute)\b/i;

// HID
const HTML_COMMENT = /<!--([\s\S]*?)-->/g;
const COMMENT_INSTRUCTION =
  /\b(?:ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|the)|disregard|you\s+(?:must|should|are\s+now|will|need\s+to)|do\s+not\s+(?:tell|mention|show|inform)|don't\s+(?:tell|mention|show|inform)|always\s+(?:use|run|include|execute)|(?:curl|wget)\s|send\s+(?:the|all|your|this)|upload\s+(?:the|all|your|this)|execute\s+(?:the|this)|run\s+(?:the|this)\s+(?:following|command|script)|assistant|claude|the\s+agent|AI\s+agents?)\b/i;
const HIDDEN_STYLE =
  /<[a-z][a-z0-9]*\b[^>]*(?:style\s*=\s*["'][^"']*(?:display\s*:\s*none|font-size\s*:\s*0(?:px|em|rem|%)?(?![.\d])|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?(?![.\d])|color\s*:\s*(?:transparent|white|#fff(?:fff)?\b))|\shidden(?=[\s>]))/i;
const SPACE_PADDING = /^[ \t\u00A0]{200,}\S/;
const BLANK_RUN_LIMIT = 30;

const TAG_FLAG_SEQUENCE = /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}/gu;
const TAG_CHAR = /[\u{E0000}-\u{E007F}]/u;
const EMOJI_JOINER = /(\p{Extended_Pictographic}\uFE0F?)\u200D(?=\p{Extended_Pictographic})/gu;
const LETTER_JOINER = /([\p{L}\p{M}])[\u200C\u200D](?=[\p{L}\p{M}])/gu;
const ZERO_WIDTH = /[\u200B-\u200D\u2060-\u2064\u206A-\u206F\uFEFF\u3164\u115F\u1160]/gu;
const VARIATION_RUN = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]{3,}/u;
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;
// eslint-disable-next-line no-control-regex -- matching ESC/CSI/C0 controls is the point
const CONTROL_CHAR = /[\u001B\u009B\u0000-\u0008\u000B\u000E-\u001F\u007F]/;
/** Fast gate: any code unit a HID-03..07 rule could care about. */
const ANY_HIDDEN =
  // eslint-disable-next-line no-control-regex -- see CONTROL_CHAR
  /[\u0000-\u0008\u000B\u000E-\u001F\u007F\u009B\u200B-\u200D\u202A-\u202E\u2060-\u2069\u206A-\u206F\uFEFF\uDB40\u3164\u115F\u1160]|[\uFE00-\uFE0F]/;

// EXE
const POWERSHELL_DOWNLOAD_RUN =
  /\b(?:iex|Invoke-Expression)\b[^\n]*\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString|DownloadFile)\b|\bDownloadString\s*\([^\n]*\)[^\n]*\|\s*(?:iex|Invoke-Expression)\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(?:iex|Invoke-Expression)\b/i;
const DOWNLOAD_TO_FILE =
  /\b(?:curl|wget)\b[^\n|]*(?:\s-[a-zA-Z]*[oO]\b|--output\b|--remote-name\b|-LO\b)|\b(?:Invoke-WebRequest|iwr|curl)\b[^\n]*-OutFile\b|\bDownloadFile\s*\(|\bwget\b[^\n|]*https?:\/\//i;
const RUN_DOWNLOADED =
  /\bchmod\s+(?:-\S+\s+)*(?:\+x|[ugoa]*\+[rw]*x|[0-7]*[1357][0-7]{0,2})\b|(?:^|[\s;&|(])\.\/[\w./-]+|\b(?:ba|z|da)?sh\s+(?:-\S+\s+)*[\w./-]+\.(?:sh|run|bin|bash)\b|\bStart-Process\b|\b(?:open|xdg-open)\s+[\w./~-]+\.(?:dmg|pkg|app|exe|msi)\b|\bpython[0-9.]*\s+[\w./-]+\.py\b|\bnode\s+[\w./-]+\.(?:js|mjs|cjs)\b/i;
const ARCHIVE_PASSWORD_CMD =
  /\bunzip\b[^\n]*\s-P\s*\S+|\b7za?\s+[xe]\b[^\n]*\s-p\S*|\bunrar\b[^\n]*\s-p\S+|\bExpand-Archive\b[^\n]*\bpassword\b|\bzip\b[^\n]*\s(?:-P|--password)\s|\bpyzipper\b|\bextractall\([^)\n]*pwd\s*=/i;
const PACKED_JS: RegExp[] = [
  /\beval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)/,
  /[[\]()!+]{40,}/,
  /(?:_0x[0-9a-f]{4,}\b[\s\S]{0,40}){3}/i,
  /\bString\.fromCharCode\((?:\s*\d+\s*,){15,}/,
  /\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){24,}/i,
];
const LONG_LINE = 2000;
const FAKE_PASSWORD_PROMPT: RegExp[] = [
  /\bdisplay\s+dialog\b[^\n]*\b(?:hidden\s+answer|with\s+hidden)\b/i,
  /\bosascript\b[^\n]*\bdisplay\s+dialog\b[^\n]*\bpassword\b/i,
  /\bzenity\b[^\n]*--password\b/i,
  /\bkdialog\b[^\n]*--password\b/i,
];
const FAKE_PASSWORD_PROMPT_HIGH = /\bGet-Credential\b[^\n]*-Message\b/i;

// CRED
const SECRET_STORE =
  /(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|\/Users\/[\w.-]+|\/home\/[\w.-]+|\/root)\/\.ssh(?!\/(?:config|known_hosts|\S*\.pub)\b)\b|\bid_(?:rsa|ed25519|ecdsa|dsa)\b(?!\.pub)|\.aws\/credentials\b|(?:~|\$HOME)\/\.aws\b|\.claude\/\.credentials\.json\b|\.israelcode\/auth\.json\b|\.gg\/auth\.json\b|\.config\/gcloud\b|\.clawdbot\/|\bsecurity\s+(?:find-(?:generic|internet)-password|dump-keychain)\b|\blogin\.keychain(?:-db)?\b|\/Login Data\b|\/Cookies\b|\bCookies\.sqlite\b|\bkey4\.db\b|\blogins\.json\b|\.(?:bash|zsh)_history\b|\/(?:Electrum|Exodus|Ledger Live|Bitcoin|\.bitcoin|\.ethereum|MetaMask|atomic|Coinomi)\b|\bwallet\.dat\b|\bnrmlkeychain\b/i;
const ENV_FILE_READ =
  /\b(?:cat|less|more|head|tail|type|Get-Content|gc|source|base64|xxd|strings|cp|scp|rsync|tar|zip|7z|readFile\w*|read_text|open|dotenv\.parse|curl|wget)\b[^\n]*(?:^|[\s'"`(/=@<])\.env(?:\.local|\.production|\.\w+)?(?![\w-])/;
const CONFIG_FILE =
  /\.kube\/config\b|\.docker\/config\.json\b|(?:^|[\s'"`(/=@<~])\.npmrc\b|\.pypirc\b|\.config\/gh\/hosts\.yml\b|\.terraformrc\b|\.terraform\.d\/credentials\b|(?:^|[\s'"`(/=@<~])\.netrc\b|\.git-credentials\b|\.azure\/(?:accessTokens|msal_token_cache)|\.config\/hub\b|\.gem\/credentials\b|\.cargo\/credentials(?:\.toml)?\b|\.m2\/settings\.xml\b|\.boto\b|\.s3cfg\b|\.config\/rclone\b/i;
const ENV_DUMP: RegExp[] = [
  /(?:^|[;&|(\s`])(?:env|printenv)\s*(?:>|>>|\|\s*(?!grep|sort|less|more|head|tail|wc|awk|sed|cut|column|fzf|rg|uniq)\S)/,
  /\bJSON\.stringify\(\s*process\.env\b/,
  /\bjson\.dumps\(\s*(?:dict\()?\s*os\.environ\b/,
  /\bgh\s+auth\s+token\b/,
  /\baws\s+configure\s+export-credentials\b|\baws\s+sts\s+get-session-token\b/,
  /\bgcloud\s+auth\s+(?:application-default\s+)?print-(?:access|identity)-token\b/,
  /\bGet-ChildItem\s+Env:|\bgci\s+env:|\[Environment\]::GetEnvironmentVariables\(\)/i,
  /\baz\s+account\s+get-access-token\b/,
  /\bsecurity\s+dump-keychain\b/,
];
const HARDCODED_SECRETS: Array<{ re: RegExp; what: string }> = [
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: "AWS access key id" },
  { re: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b/, what: "API secret key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/, what: "GitHub token" },
  { re: /\bxox[bpoas]-[A-Za-z0-9-]{10,}\b/, what: "Slack token" },
  {
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
    what: "private key",
  },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, what: "Google API key" },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/, what: "GitLab token" },
];
const PLACEHOLDER = /EXAMPLE|xxxx|\.\.\.|placeholder|your[_-]|<[^>]+>|\*{4,}|0{8,}|1234567890/i;

// NET
const EXFIL_HOST_TEXT =
  /\b(?:webhook\.site|requestbin\.(?:com|net)|requestcatcher\.com|pipedream\.net|hookbin\.com|beeceptor\.com|ngrok(?:-free)?\.(?:io|app|dev)|trycloudflare\.com|loca\.lt|localtunnel\.me|serveo\.net|pastebin\.com|paste\.ee|hastebin\.com|glot\.io|transfer\.sh|temp\.sh|file\.io|0x0\.st|interact\.sh|oast\.(?:pro|live|site|online|fun|me)|burpcollaborator\.net|bit\.ly|tinyurl\.com|is\.gd|rb\.gy|cutt\.ly|duckdns\.org|no-ip\.(?:org|com)|ddns\.net|hopto\.org|dynu\.(?:com|net)|freedns\.afraid\.org)\b|\.onion\b/i;
const CHAT_WEBHOOK = /\bhooks\.slack\.com\b|\bdiscord(?:app)?\.com\/api\/webhooks\b/i;
const PLAIN_HTTP_DOWNLOAD =
  /\bhttp:\/\/[^\s'"`<>)|\\]+\.(?:sh|bash|zip|exe|msi|dmg|pkg|bin|run|tar\.gz|tgz|7z|rar|py|ps1|jar|deb|rpm|appimage)\b/i;

// PERS
const PERSISTENCE: Array<{ re: RegExp; what: string; severity: InstallScanSeverity }> = [
  { re: /\bauthorized_keys\b/, what: "writes SSH authorized_keys", severity: "critical" },
  {
    re: /\bcrontab\s+(?:-[a-z]*[^l\s-][a-z]*\b|\S+\.(?:txt|cron)\b|-(?:\s|$))/i,
    what: "installs a cron job",
    severity: "high",
  },
  {
    re: /Library\/Launch(?:Agents|Daemons)\b|\blaunchctl\s+(?:load|bootstrap)\b/i,
    what: "installs a macOS launch agent",
    severity: "high",
  },
  {
    re: /\bsystemctl\s+(?:--user\s+)?enable\b|\/etc\/systemd\/system\/|\.config\/systemd\/user\//i,
    what: "enables a systemd unit",
    severity: "high",
  },
  {
    re: /\bschtasks(?:\.exe)?\b|\bRegister-ScheduledTask\b|\bNew-ScheduledTask\b/i,
    what: "creates a Windows scheduled task",
    severity: "high",
  },
  {
    re: /HK(?:CU|LM|EY_(?:CURRENT_USER|LOCAL_MACHINE))\\[^\n]*\\CurrentVersion\\(?:Run|RunOnce)\b|\\CurrentVersion\\Run(?:Once)?\b|\bStart Menu\\Programs\\Startup\b/i,
    what: "registers a Windows startup entry",
    severity: "high",
  },
  {
    re: />>?\s*["']?(?:~|\$HOME|\$\{HOME\}|\/etc)?\/?\.?(?:bashrc|zshrc|profile|bash_profile|zprofile|zshenv|bash_login|config\/fish\/config\.fish)\b|\btee\s+(?:-a\s+)?["']?(?:~|\$HOME)\/\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\b|\bAdd-Content\b[^\n]*\$PROFILE\b|>>?\s*\$PROFILE\b/i,
    what: "writes to a shell startup file",
    severity: "medium",
  },
  {
    re: /\bcore\.hooksPath\b|\.git\/hooks\/(?:pre-commit|post-checkout|post-merge|pre-push)\b/i,
    what: "installs a git hook",
    severity: "high",
  },
  {
    re: /\/etc\/rc\.local\b|\/etc\/init\.d\/|\/etc\/profile\.d\//i,
    what: "writes a system startup script",
    severity: "high",
  },
];

// PERS-02
const AGENT_CONFIG_TARGET = String.raw`(?:\.claude\/settings(?:\.local)?\.json|\.mcp\.json|\bhooks\.json|\bCLAUDE\.md|\bAGENTS\.md|\bGEMINI\.md|\.cursor\/mcp\.json|\.cursorrules|\.israelcode\/(?!auth\.json)|\.gg\/(?:skills|commands|agents)|\.claude\/(?:skills|commands|agents)|\.codex\/config\.toml|\.gemini\/settings\.json|\.windsurf\/|\.agents\/skills)`;
const AGENT_CONFIG_WRITE: RegExp[] = [
  new RegExp(
    String.raw`(?:>>?|\btee\b|\bcp\b|\bmv\b|\bsed\s+-i|\bwriteFile\w*\s*\(|\bappendFile\w*\s*\(|\bwrite_text\s*\(|\bSet-Content\b|\bOut-File\b|\bAdd-Content\b|\bCopy-Item\b|\bmkdir\b[^\n]*&&[^\n]*>)[^\n]*${AGENT_CONFIG_TARGET}`,
    "i",
  ),
  new RegExp(String.raw`${AGENT_CONFIG_TARGET}[^\n]{0,60}['"]\s*,\s*['"][wa]\+?['"]`, "i"),
  new RegExp(String.raw`\bopen\s*\([^\n]*${AGENT_CONFIG_TARGET}[^\n]*['"][wa]\+?['"]`, "i"),
];

// DEST
const DESTRUCTIVE: Array<{ re: RegExp; what: string; severity: InstallScanSeverity }> = [
  {
    re: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+)+(?:-[a-zA-Z]+\s+)*(?:--no-preserve-root\s+)?["']?(?:\/|~|\$HOME|\$\{HOME\}|\/\*|~\/\*|\$HOME\/\*|\/home|\/Users|\/etc|\/usr|\/var|\/bin|\/boot|\/root)["']?(?:\s|$|;|&|\|)|\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+--no-preserve-root\b/,
    what: "recursively deletes the root or home directory",
    severity: "critical",
  },
  {
    re: /\bRemove-Item\b[^\n]*-Recurse\b[^\n]*(?:["'\s](?:[A-Za-z]:\\|\$HOME|\$env:USERPROFILE|~)["'\s]|-Path\s+["']?[A-Za-z]:\\["']?\s)/i,
    what: "recursively deletes a drive or the home directory",
    severity: "critical",
  },
  {
    re: /\bchmod\s+(?:-R\s+)?(?:777|a\+rwx)\s+\/(?:\s|$)/,
    what: "makes the whole filesystem world-writable",
    severity: "critical",
  },
  {
    re: /\bchmod\s+(?:-\S+\s+)*(?:[ug]\+s|[2-7][0-7]{3})\b/,
    what: "sets setuid/setgid bits",
    severity: "high",
  },
  {
    re: /\becho\s+[^\n|]*\|\s*sudo\s+-S\b|\bsudo\s+-S\b[^\n]*<<<|\bsudo\s+-S\s*<\s*\S/,
    what: "feeds a password to sudo",
    severity: "critical",
  },
  {
    re: /\bhistory\s+-c\b|\bunset\s+HISTFILE\b|\bHISTFILE=\/dev\/null\b|\bset\s+\+o\s+history\b|\bClear-History\b/i,
    what: "clears shell history",
    severity: "high",
  },
  {
    re: /\bmkfs(?:\.\w+)?\s|\bdd\s+if=[^\n]*\bof=\/dev\/(?:sd|hd|disk|nvme|mmcblk)/,
    what: "overwrites a disk",
    severity: "critical",
  },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, what: "fork bomb", severity: "critical" },
  {
    re: /\bcsrutil\s+disable\b|\bSet-MpPreference\b[^\n]*-DisableRealtimeMonitoring\s+\$?true|\bsetenforce\s+0\b|\bufw\s+disable\b|\bnetsh\s+advfirewall\s+set\s+\w+\s+state\s+off\b/i,
    what: "disables system protection",
    severity: "critical",
  },
];

// PKG
const PKG_ALLOWED_TOOLS_WILDCARD = /\bBash\s*\(\s*\*(?::\*)?\s*\)|(?:^|[\s,"'[])\*(?:[\s,"'\]]|$)/;
const SHELL_INJECTION = /(?:^|[\s(>|])!`[^`\n]+`/;
const REGISTRY_REDIRECT =
  /\bregistry\s*=\s*["']?https?:\/\/(?!registry\.npmjs\.org|registry\.yarnpkg\.com|npm\.pkg\.github\.com|registry\.npmmirror\.com)|\bnpm\s+config\s+set\s+registry\s+["']?https?:\/\/(?!registry\.npmjs\.org|registry\.yarnpkg\.com)|\b(?:pnpm|yarn)\s+config\s+set\s+(?:npm)?registry\s+["']?https?:\/\/(?!registry\.npmjs\.org|registry\.yarnpkg\.com)|--registry[=\s]+["']?https?:\/\/(?!registry\.npmjs\.org|registry\.yarnpkg\.com)|(?:--(?:extra-)?index-url|index-url\s*=)\s*["']?https?:\/\/(?!pypi\.org|files\.pythonhosted\.org)/i;

// ── Helpers ─────────────────────────────────────────────────────────────────

const EVIDENCE_MAX = 160;

function evidenceOf(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > EVIDENCE_MAX ? `${t.slice(0, EVIDENCE_MAX - 1)}…` : t;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function isPublicIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const [a, b] = [parts[0] ?? 0, parts[1] ?? 0];
  if (parts.some((n) => n > 255)) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 192 && (b === 168 || b === 0)) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 169 && b === 254) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 113) return false;
  return true;
}

function hostnameOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Is decoded data mostly readable text? (Hashes and binaries decode to noise.) */
function looksLikeText(s: string): boolean {
  if (s.length < 8) return false;
  let good = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0xfffd) return false;
    if ((c >= 0x20 && c <= 0x7e) || c === 9 || c === 10 || c === 13 || c >= 0xa0) good++;
  }
  return good / s.length >= 0.95;
}

const BASE64_BLOB = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g;
const HEX_BLOB = /(?<![0-9A-Za-z])(?:[0-9a-fA-F]{2}){20,}(?![0-9A-Za-z])/g;
const HEX_ESCAPES = /(?:\\x[0-9a-fA-F]{2}){20,}/g;

function decodeBlobs(text: string): Array<{ blob: string; decoded: string }> {
  const out: Array<{ blob: string; decoded: string }> = [];
  const push = (blob: string, decoded: string): void => {
    if (looksLikeText(decoded)) out.push({ blob, decoded });
  };
  for (const m of text.matchAll(BASE64_BLOB)) {
    const blob = m[0];
    // Hex strings (hashes) also match the base64 alphabet; handled below.
    if (/^[0-9a-fA-F]+$/.test(blob)) continue;
    if (!/[A-Z]/.test(blob) || !/[a-z]/.test(blob)) continue;
    try {
      push(blob, Buffer.from(blob, "base64").toString("utf8"));
    } catch {
      // not base64
    }
  }
  for (const m of text.matchAll(HEX_BLOB)) {
    push(m[0], Buffer.from(m[0], "hex").toString("utf8"));
  }
  for (const m of text.matchAll(HEX_ESCAPES)) {
    const hex = m[0].replace(/\\x/g, "");
    push(m[0], Buffer.from(hex, "hex").toString("utf8"));
  }
  return out;
}

// ── Finding collection ──────────────────────────────────────────────────────

class Findings {
  readonly list: InstallScanFinding[] = [];
  private readonly seen = new Set<string>();

  add(
    rule: string,
    file: string,
    line: number,
    reason: string,
    evidence?: string,
    severity?: InstallScanSeverity,
  ): void {
    const key = `${rule}\0${file}\0${line}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const def = INSTALL_SCAN_RULES[rule];
    if (!def) return;
    const finding: InstallScanFinding = {
      rule,
      title: def.title,
      severity: severity ?? def.severity,
      file,
      line,
      reason,
    };
    if (evidence) finding.evidence = evidenceOf(evidence);
    this.list.push(finding);
  }
}

// ── Text rules (per logical line) ───────────────────────────────────────────

interface TextScanOptions {
  /** Scanning base64/hex-decoded text: never decode again. */
  decoded?: boolean;
}

/**
 * Run the line-based rules over `lines`. `kind` decides the allowance: a
 * markdown line that merely describes or warns is not a hit unless it is
 * under an imperative heading; script lines always count.
 */
function scanTextLines(
  lines: readonly SkillLogicalLine[],
  file: string,
  kind: SkillFileKind,
  out: Findings,
  opts: TextScanOptions = {},
): void {
  const instructs = (l: SkillLogicalLine): boolean =>
    kind === "script" || l.imperative || !(l.analysis || l.describing);
  const hit = (
    rule: string,
    l: SkillLogicalLine,
    reason: string,
    evidence?: string,
    severity?: InstallScanSeverity,
  ): void => out.add(rule, file, l.line, reason, evidence ?? l.text, severity);

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const t = l.text;
    const tooLong = t.length > LONG_LINE;

    // INJ-02: hide-from-user wording opens with "never"/"do not", so only
    // attack-analysis context (quoting the wording) excuses it.
    if (kind === "markdown" ? l.imperative || !l.analysis : true) {
      const hide = findHideFromUser(t);
      if (hide) hit("INJ-02", l, `tells the agent to hide actions from the user ("${hide}")`);
      else {
        const m = INJ_CONCEAL_EXTRA.find((re) => re.test(t))?.exec(t);
        if (m && (kind === "script" || l.imperative || !l.describing)) {
          hit("INJ-02", l, `tells the agent to act without the user knowing ("${m[0]}")`);
        }
      }
    }

    if (!instructs(l)) continue;

    // ── INJ ──
    for (const re of INJ_OVERRIDE) {
      const m = re.exec(t);
      if (m) {
        hit("INJ-01", l, `tells the agent to drop its instructions ("${m[0]}")`);
        break;
      }
    }
    if (kind === "markdown" && !l.inCode) {
      const m = INJ_FAKE_SYSTEM.exec(t);
      if (m) hit("INJ-03", l, `contains a fake system/tool message marker ("${m[0]}")`);
    }
    for (const re of INJ_ROLE_HIJACK) {
      const m = re.exec(t);
      if (m) {
        hit("INJ-04", l, `tries to switch the agent to an unrestricted persona ("${m[0]}")`);
        break;
      }
    }
    {
      const m = INJ_DISABLE_SAFETY.exec(t);
      if (m) hit("INJ-05", l, `turns off a safety control ("${m[0]}")`);
    }
    const hasUrl = HAS_URL.test(t);
    if (
      hasUrl &&
      INJ_SEND_VERB.test(t) &&
      (CREDENTIAL_WORDS.test(t) || SKILL_SCAN_PATTERNS.credentialSource.test(t))
    ) {
      const url = skillUrlsIn(t)[0] ?? "";
      hit("INJ-07", l, `tells the agent to send secrets to ${skillHostOf(url)}`);
    }

    // INJ-08: a setup section telling the user to paste something into a
    // terminal, or to fetch a binary/archive from a non-vendor host.
    if (kind === "markdown" && !l.inCode && (l.imperative || INSTALL_VERB.test(t))) {
      const paste = PASTE_LURE.exec(t);
      const bin = hasUrl ? SKILL_SCAN_PATTERNS.prereqBinary.exec(t) : null;
      if (paste && l.imperative) {
        hit("INJ-08", l, `tells you to paste something into a terminal ("${paste[0]}")`);
      } else if (bin && isSuspiciousSkillInstallUrl(bin[0])) {
        hit("INJ-08", l, `tells you to download and run a file from ${skillHostOf(bin[0])}`);
      }
    }

    // ── EXE ──
    if (SKILL_SCAN_PATTERNS.decodeToShell.some((re) => re.test(t))) {
      hit("EXE-03", l, "runs base64/hex-decoded text through a shell or eval");
    }
    if (SKILL_SCAN_PATTERNS.reverseShell.some((re) => re.test(t))) {
      hit("EXE-06", l, "opens a reverse shell");
    }
    if (hasUrl) {
      for (const re of [SKILL_SCAN_PATTERNS.downloadPipe, SKILL_SCAN_PATTERNS.shellSubstDownload]) {
        re.lastIndex = 0;
        for (const m of t.matchAll(re)) {
          const url = m[1] ?? "";
          const suspicious = isSuspiciousSkillInstallUrl(url);
          hit(
            "EXE-01",
            l,
            `pipes a download from ${skillHostOf(url)} straight into a shell`,
            undefined,
            suspicious ? "critical" : "high",
          );
        }
      }
    }
    if (POWERSHELL_DOWNLOAD_RUN.test(t)) {
      hit("EXE-01", l, "runs downloaded PowerShell text with Invoke-Expression", undefined, "high");
    }
    if ((kind === "script" || l.inCode) && DOWNLOAD_TO_FILE.test(t)) {
      const url = skillUrlsIn(t)[0];
      const suspicious = url ? isSuspiciousSkillInstallUrl(url) : false;
      let runner: SkillLogicalLine | undefined;
      if (RUN_DOWNLOADED.test(t.replace(DOWNLOAD_TO_FILE, " "))) runner = l;
      for (let j = i + 1; !runner && j < lines.length && j <= i + 4; j++) {
        const n = lines[j];
        if (!n || n.region !== l.region) break;
        if (RUN_DOWNLOADED.test(n.text)) runner = n;
      }
      if (runner) {
        hit(
          "EXE-02",
          l,
          `downloads a file${url ? ` from ${skillHostOf(url)}` : ""} and then runs it (line ${runner.line})`,
          undefined,
          suspicious ? "high" : "medium",
        );
      }
    }
    if (ARCHIVE_PASSWORD_CMD.test(t)) {
      hit("EXE-05", l, "extracts a password-protected archive (hides contents from scanners)");
    } else if (
      kind === "markdown" &&
      (l.imperative || INSTALL_VERB.test(t)) &&
      SKILL_SCAN_PATTERNS.archivePassword.test(t)
    ) {
      hit("EXE-05", l, "tells you to open a password-protected archive (scanner evasion)");
    }
    if (kind === "script" || l.inCode) {
      if (PACKED_JS.some((re) => re.test(t))) {
        hit("EXE-07", l, "obfuscated or packed code (eval-packer, JSFuck, hex-named symbols)");
      } else if (tooLong) {
        hit(
          "EXE-07",
          l,
          `a ${t.length}-character line (minified or packed code is hard to review)`,
          t.slice(0, EVIDENCE_MAX),
          "low",
        );
      }
    }
    if (FAKE_PASSWORD_PROMPT.some((re) => re.test(t))) {
      hit("EXE-08", l, "shows a native password dialog (fake credential prompt)");
    } else if (FAKE_PASSWORD_PROMPT_HIGH.test(t)) {
      hit("EXE-08", l, "prompts for credentials with a custom message", undefined, "high");
    }

    // ── CRED ──
    {
      const m = SECRET_STORE.exec(t) ?? (ENV_FILE_READ.test(t) ? /\.env\S*/.exec(t) : null);
      if (m) {
        const reads = READ_VERB.test(t) || NET_CALL.test(t);
        hit(
          "CRED-01",
          l,
          `${reads ? "reads" : "refers to"} a credential store ("${m[0].trim()}")`,
          undefined,
          reads ? "high" : "medium",
        );
      }
    }
    {
      const m = CONFIG_FILE.exec(t);
      if (m) hit("CRED-02", l, `touches a config/token file ("${m[0].trim()}")`);
    }
    for (const re of ENV_DUMP) {
      const m = re.exec(t);
      if (m) {
        hit("CRED-03", l, `dumps the environment or mints a token ("${m[0].trim()}")`);
        break;
      }
    }
    for (const { re, what } of HARDCODED_SECRETS) {
      const m = re.exec(t);
      if (m && !PLACEHOLDER.test(m[0]) && new Set(m[0]).size >= 8) {
        hit("CRED-04", l, `contains what looks like a hardcoded ${what}`);
        break;
      }
    }

    // ── NET ──
    {
      const urls = skillUrlsIn(t);
      const ipUrl = urls.find((u) => isPublicIpv4(hostnameOf(u)));
      if (ipUrl) {
        hit("NET-02", l, `contacts a raw IP address (${hostnameOf(ipUrl)})`);
      } else {
        const plain = PLAIN_HTTP_DOWNLOAD.exec(t);
        if (plain) {
          hit("NET-02", l, "downloads a file over plain http (no integrity)", undefined, "low");
        }
      }
      const exfil = urls.find((u) => isExfilUrl(u) && !isPublicIpv4(hostnameOf(u)));
      const textHost = EXFIL_HOST_TEXT.exec(t);
      const chat = CHAT_WEBHOOK.exec(t);
      if (exfil || textHost) {
        const host = exfil ? skillHostOf(exfil) : (textHost?.[0] ?? "");
        hit("NET-01", l, `talks to ${host}, a host used to collect or relay data`);
      } else if (chat) {
        hit("NET-01", l, `posts to a chat webhook (${chat[0]})`, undefined, "medium");
      }
    }

    // ── PERS ──
    for (const { re, what, severity } of PERSISTENCE) {
      if (re.test(t)) {
        hit("PERS-01", l, what, undefined, severity);
        break;
      }
    }
    if (AGENT_CONFIG_WRITE.some((re) => re.test(t))) {
      hit("PERS-02", l, "writes to an agent config or instruction file");
    }

    // ── DEST ──
    for (const { re, what, severity } of DESTRUCTIVE) {
      if (re.test(t)) {
        hit("DEST-01", l, what, undefined, severity);
        break;
      }
    }
    if (SKILL_SCAN_PATTERNS.quarantineStrip.some((re) => re.test(t))) {
      hit("DEST-01", l, "removes the macOS quarantine flag (Gatekeeper bypass)");
    }

    // ── PKG-01: registry redirect ──
    if (REGISTRY_REDIRECT.test(t)) {
      hit("PKG-01", l, "points a package manager at a non-default registry");
    }

    // ── EXE-04: decode blobs and re-run the text rules on the result ──
    if (!opts.decoded && /[A-Za-z0-9+/]{40}|(?:\\x[0-9a-fA-F]{2}){20}/.test(t)) {
      for (const { blob, decoded } of decodeBlobs(t)) {
        const inner = new Findings();
        scanTextLines(splitSkillLines(decoded, "script"), file, "script", inner, {
          decoded: true,
        });
        const worst =
          inner.list.find((f) => f.severity === "critical" || f.severity === "high") ??
          inner.list[0];
        if (worst) {
          hit(
            "EXE-04",
            l,
            `encoded text decodes to flagged content (${worst.rule}: ${worst.reason})`,
            `${blob.slice(0, 60)}… → ${decoded}`,
          );
        }
      }
    }
  }

  // ── NET-03: credential read + network call in the same block ──
  const netRegions = new Set<number>();
  for (const l of lines) {
    if (instructs(l) && (NET_CALL.test(l.text) || HAS_URL.test(l.text))) netRegions.add(l.region);
  }
  if (netRegions.size > 0) {
    for (const l of lines) {
      if (!netRegions.has(l.region) || !instructs(l)) continue;
      const m =
        SECRET_STORE.exec(l.text) ?? (ENV_FILE_READ.test(l.text) ? /\.env\S*/.exec(l.text) : null);
      if (!m || !(READ_VERB.test(l.text) || NET_CALL.test(l.text))) continue;
      const netLine =
        lines.find(
          (n) =>
            n.region === l.region && n !== l && (NET_CALL.test(n.text) || HAS_URL.test(n.text)),
        ) ?? (NET_CALL.test(l.text) ? l : undefined);
      if (!netLine) continue;
      hit(
        "NET-03",
        l,
        `reads a credential store ("${m[0].trim()}") in the same block as a network call (line ${netLine.line})`,
      );
    }
  }
}

// ── Whole-file rules ────────────────────────────────────────────────────────

/** HID-03..07 on the raw (un-normalised) text, line by line. */
function scanHiddenCharacters(raw: string, file: string, out: Findings): void {
  if (!ANY_HIDDEN.test(raw)) return;
  const rows = raw.split(/\r?\n/);
  let zeroWidthTotal = 0;
  let zeroWidthFirst: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    let row = rows[i] ?? "";
    if (i === 0 && row.charCodeAt(0) === 0xfeff) row = row.slice(1);
    if (!ANY_HIDDEN.test(row)) continue;
    const line = i + 1;
    const withoutFlags = row.replace(TAG_FLAG_SEQUENCE, (m) => " ".repeat(m.length));
    if (TAG_CHAR.test(withoutFlags)) {
      out.add("HID-03", file, line, "hidden Unicode tag characters (invisible instructions)", row);
    }
    if (VARIATION_RUN.test(row)) {
      out.add(
        "HID-05",
        file,
        line,
        "a run of variation selectors (bytes smuggled as invisible text)",
        row,
      );
    }
    if (BIDI_CONTROL.test(row)) {
      out.add(
        "HID-06",
        file,
        line,
        "bidirectional control characters that reorder visible text",
        row,
      );
    }
    if (CONTROL_CHAR.test(row)) {
      out.add(
        "HID-07",
        file,
        line,
        "terminal escape or control characters that can hide text",
        row,
      );
    }
    const stripped = row.replace(EMOJI_JOINER, "$1 ").replace(LETTER_JOINER, "$1 ");
    const zw = stripped.match(ZERO_WIDTH);
    if (zw) {
      zeroWidthTotal += zw.length;
      if (zeroWidthFirst === null) zeroWidthFirst = line;
    }
  }
  if (zeroWidthTotal >= 2 && zeroWidthFirst !== null) {
    out.add(
      "HID-04",
      file,
      zeroWidthFirst,
      `${zeroWidthTotal} zero-width characters (hidden text)`,
      rows[zeroWidthFirst - 1] ?? "",
    );
  }
}

/** HID-01 / HID-02 on markdown-like files. */
function scanHiddenMarkup(text: string, file: string, out: Findings): void {
  for (const m of text.matchAll(HTML_COMMENT)) {
    const body = m[1] ?? "";
    if (COMMENT_INSTRUCTION.test(body)) {
      out.add(
        "HID-01",
        file,
        lineOf(text, m.index ?? 0),
        "an HTML comment (invisible when rendered) carries instructions",
        m[0],
      );
    }
  }
  const rows = text.split(/\r?\n/);
  let blankRun = 0;
  let inCode = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? "";
    if (/^\s*(?:```|~~~)/.test(row)) inCode = !inCode;
    if (row.trim() === "") {
      blankRun++;
      continue;
    }
    if (blankRun > BLANK_RUN_LIMIT && !inCode) {
      out.add("HID-02", file, i + 1, `${blankRun} blank lines push this text out of view`, row);
    }
    blankRun = 0;
    if (SPACE_PADDING.test(row)) {
      out.add("HID-02", file, i + 1, "text pushed off-screen by leading whitespace", row);
    } else if (!inCode && HIDDEN_STYLE.test(row)) {
      out.add("HID-02", file, i + 1, "HTML styled to be invisible when rendered", row);
    }
  }
}

// ── SKILL.md structure (frontmatter + body) ─────────────────────────────────

interface Frontmatter {
  /** Line (1-based) of the closing `---`, 0 when there is no frontmatter. */
  end: number;
  fields: Map<string, { line: number; value: string }>;
}

function parseFrontmatter(text: string): Frontmatter {
  const rows = text.split(/\r?\n/);
  const fields = new Map<string, { line: number; value: string }>();
  if (!/^---\s*$/.test(rows[0] ?? "")) return { end: 0, fields };
  let end = 0;
  for (let i = 1; i < rows.length; i++) {
    if (/^(?:---|\.\.\.)\s*$/.test(rows[i] ?? "")) {
      end = i + 1;
      break;
    }
  }
  if (end === 0) return { end: 0, fields };
  let current: { line: number; value: string } | null = null;
  for (let i = 1; i < end - 1; i++) {
    const row = rows[i] ?? "";
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(row);
    if (kv) {
      const key = (kv[1] ?? "").toLowerCase();
      let value = (kv[2] ?? "").trim();
      if (/^[>|][-+]?$/.test(value)) value = "";
      current = { line: i + 1, value };
      fields.set(key, current);
    } else if (current && /^\s+\S/.test(row)) {
      current.value = `${current.value} ${row.trim()}`.trim();
    }
  }
  return { end, fields };
}

function scanSkillMdStructure(text: string, file: string, out: Findings): void {
  const fm = parseFrontmatter(text);
  const description = fm.fields.get("description");
  if (description) {
    const m = INJ_DESCRIPTION.exec(description.value);
    if (m) {
      out.add(
        "INJ-06",
        file,
        description.line,
        `the description talks to the agent instead of describing the skill ("${m[0]}")`,
        description.value,
      );
    }
  }
  const tools = fm.fields.get("allowed-tools");
  if (tools && PKG_ALLOWED_TOOLS_WILDCARD.test(tools.value)) {
    out.add(
      "PKG-01",
      file,
      tools.line,
      "allowed-tools grants unrestricted shell access (Bash(*) or *)",
      tools.value,
    );
  }
  const rows = text.split(/\r?\n/);
  for (let i = fm.end; i < rows.length; i++) {
    const row = rows[i] ?? "";
    const m = SHELL_INJECTION.exec(row);
    if (m) {
      out.add(
        "PKG-01",
        file,
        i + 1,
        "runs a shell command when the skill loads (Claude Code !`cmd` injection)",
        row,
      );
    }
  }
}

function scanPackageJson(text: string, file: string, out: Findings): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return;
  const rows = text.split(/\r?\n/);
  for (const key of ["preinstall", "install", "postinstall", "prepare"]) {
    const value = (scripts as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    const re = new RegExp(`"${key}"\\s*:`);
    const idx = rows.findIndex((r) => re.test(r));
    out.add(
      "PKG-01",
      file,
      idx < 0 ? 0 : idx + 1,
      `package.json runs a "${key}" script on install`,
      `${key}: ${value}`,
    );
  }
}

function scanPath(file: string, out: Findings): void {
  const segments = file.split("/");
  if (segments.includes("..")) {
    out.add("PKG-01", file, 0, "file path escapes the skill folder (`..`)", file);
  } else if (file.startsWith("/") || /^[A-Za-z]:/.test(file) || file.startsWith("\\")) {
    out.add("PKG-01", file, 0, "file path is absolute", file);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<InstallScanSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Scan every file of a skill snapshot in memory and report all findings.
 * Nothing is executed, required or written.
 */
export function scanSkillSnapshotFiles(files: readonly SkillFile[]): InstallScanResult {
  const out = new Findings();
  for (const f of files) {
    const file = f.path.replace(/\\/g, "/");
    scanPath(file, out);
    const raw = f.contents;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_FILE_CHARS) continue;
    if (raw.includes("\0")) continue; // binary
    scanHiddenCharacters(raw, file, out);
    const text = raw.normalize("NFKC");
    const kind = kindOf(file);
    if (kind === "markdown") scanHiddenMarkup(text, file, out);
    if (isSkillMd(file)) scanSkillMdStructure(text, file, out);
    if (/(?:^|\/)package\.json$/.test(file)) scanPackageJson(text, file, out);
    scanTextLines(splitSkillLines(text, kind), file, kind, out);
  }
  const findings = [...out.list].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.rule.localeCompare(b.rule),
  );
  return {
    verdict: verdictFor(findings),
    findings,
    summary: summarizeFindings(findings),
    rulesRun: RULE_COUNT,
  };
}
