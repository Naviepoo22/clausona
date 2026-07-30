export type UsageRecord = {
  ts: string;
  tz?: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
};

export type UsagePeriod = "today" | "week" | "month" | "all";

export type UsageSummary = {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  rateLimits?: UsageRateLimits;
};

export type CodexSessionCursor = {
  inputTokens: number;
  outputTokens: number;
};

export type UsageRateLimitWindow = {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
};

export type UsageRateLimits = {
  observedAt: string;
  planType?: string;
  primary?: UsageRateLimitWindow;
  secondary?: UsageRateLimitWindow;
};

export type CodexRateLimitWindow = UsageRateLimitWindow;
export type CodexRateLimits = UsageRateLimits;

export type ToolName = "claude" | "codex";

export type Profile = {
  tool: ToolName;
  configDir: string;
  email: string;
  orgName?: string;
  isPrimary?: boolean;
  mergeSessions?: boolean;
};

export type Registry = {
  version: 2;
  primarySources: Partial<Record<ToolName, string>>;
  activeProfiles: Partial<Record<ToolName, string>>;
  profiles: Record<string, Profile>;
};

export type RegistryV1 = {
  primarySource: string;
  activeProfile: string;
  profiles: Record<
    string,
    {
      configDir: string;
      email: string;
      orgName?: string;
      isPrimary?: boolean;
      mergeSessions?: boolean;
    }
  >;
};

export type DiscoveredAccount = {
  tool: ToolName;
  configDir: string;
  jsonPath: string;
  email: string;
  orgName?: string;
  keychainService: string;
  isPrimary: boolean;
};

export type ProfileListItem = {
  name: string;
  tool: ToolName;
  email: string;
  orgName?: string;
  configDir: string;
  isPrimary: boolean;
  isActive: boolean;
  mergeSessions?: boolean;
  rateLimits?: UsageRateLimits;
  today: UsageSummary;
  week: UsageSummary;
  month: UsageSummary;
  total: UsageSummary;
};

export type DoctorIssue = {
  kind:
    | "missing_json"
    | "missing_oauth"
    | "missing_keychain"
    | "broken_symlink"
    | "local_override"
    | "stale_symlink"
    | "plugins_out_of_sync";
  message: string;
};

export type DoctorProfileResult = {
  name: string;
  email: string;
  configDir: string;
  isPrimary: boolean;
  healthy: boolean;
  issues: DoctorIssue[];
};

export type UsageStore = Record<
  string,
  {
    records: UsageRecord[];
    seenSessions?: Record<string, string>;
    claudeRateLimits?: UsageRateLimits;
    codexSessions?: Record<string, CodexSessionCursor>;
    codexRateLimits?: UsageRateLimits;
  }
>;

export type ParsedCommand =
  | { kind: "tui"; command: "dashboard" }
  | { kind: "command"; command: string; args: string[] }
  | { kind: "exec"; profile: string; args: string[] };
