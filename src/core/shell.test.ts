import { describe, expect, it } from "vitest";
import { renderPosixShellInit, renderPowerShellInit, renderShellInit } from "./shell.js";

describe("renderShellInit", () => {
  const out = renderPosixShellInit();

  it("defines _clausona_resolve helper that takes a tool argument", () => {
    expect(out).toMatch(/_clausona_resolve\(\)\s*\{/);
    expect(out).toMatch(/local tool=\$1/);
  });

  it("defines a claude() wrapper that sets CLAUDE_CONFIG_DIR", () => {
    expect(out).toMatch(/^claude\(\)\s*\{/m);
    expect(out).toMatch(/CLAUDE_CONFIG_DIR/);
    expect(out).toMatch(/_clausona_resolve claude/);
    expect(out).toMatch(/clausona _track-usage/);
  });

  it("defines a codex() wrapper that sets CODEX_HOME", () => {
    expect(out).toMatch(/^codex\(\)\s*\{/m);
    expect(out).toMatch(/CODEX_HOME/);
    expect(out).toMatch(/_clausona_resolve codex/);
  });

  it("tracks Codex usage after the command and before restoring CODEX_HOME", () => {
    const codexBlock = out.split(/^codex\(\)\s*\{/m)[1] ?? "";
    const commandIndex = codexBlock.indexOf('command codex "$@"');
    const trackingIndex = codexBlock.indexOf("clausona _track-usage codex");
    const restoreIndex = codexBlock.indexOf('export CODEX_HOME="$previous_codex_home"');
    expect(commandIndex).toBeGreaterThanOrEqual(0);
    expect(trackingIndex).toBeGreaterThan(commandIndex);
    expect(restoreIndex).toBeGreaterThan(trackingIndex);
  });

  it("restores a CODEX_HOME value that existed before the wrapper ran", () => {
    const codexBlock = out.split(/^codex\(\)\s*\{/m)[1] ?? "";
    expect(codexBlock).toMatch(/local had_codex_home=0/);
    expect(codexBlock).toMatch(/local previous_codex_home="\$\{CODEX_HOME:-\}"/);
    expect(codexBlock).toMatch(/export CODEX_HOME="\$previous_codex_home"/);
  });

  it("retains csn alias", () => {
    expect(out).toMatch(/alias csn=clausona/);
  });

  it("does not use ! operator in inline node script (zsh history-expansion safe)", () => {
    // The inline node script in _clausona_resolve must not use `!` operators
    // because zsh history-expands them inside double-quoted strings at function
    // definition time, corrupting the script.
    // Extract the node -e "..." script directly from the full output.
    // The script starts after `node -e "` and ends before `" 2>/dev/null`.
    const nodeMatch = out.match(/node -e "([\s\S]*?)" 2>\/dev\/null/);
    expect(nodeMatch).not.toBeNull();
    expect(nodeMatch?.[1]).not.toMatch(/!/);
  });

  it("selects PowerShell integration on Windows", () => {
    expect(renderShellInit("win32")).toBe(renderPowerShellInit());
  });
});

describe("renderPowerShellInit", () => {
  const out = renderPowerShellInit();

  it("defines wrappers for Claude and Codex with their profile environment variables", () => {
    expect(out).toMatch(/function global:claude/);
    expect(out).toMatch(/CLAUDE_CONFIG_DIR/);
    expect(out).toMatch(/function global:codex/);
    expect(out).toMatch(/CODEX_HOME/);
  });

  it("resolves active profiles from the clausona registry", () => {
    expect(out).toContain('Join-Path $HOME ".clausona\\profiles.json"');
    expect(out).toMatch(/Get-ClausonaProfileDir -Tool claude/);
    expect(out).toMatch(/Get-ClausonaProfileDir -Tool codex/);
  });

  it("restores pre-existing environment variables and keeps the csn alias", () => {
    expect(out).toMatch(/\$previousConfig = \$env:CLAUDE_CONFIG_DIR/);
    expect(out).toMatch(/\$env:CLAUDE_CONFIG_DIR = \$previousConfig/);
    expect(out).toMatch(/Set-Alias -Name csn -Value clausona -Scope Global/);
  });

  it("tracks Codex before finally restores CODEX_HOME and preserves its exit code", () => {
    const codexBlock = out.split("function global:codex")[1] ?? "";
    expect(codexBlock).toMatch(
      /& \$command\.Source @Arguments\s+\$exitCode = \$LASTEXITCODE\s+clausona _track-usage codex \*>\s*\$null\s+\$global:LASTEXITCODE = \$exitCode\s+} finally \{/,
    );
    expect(codexBlock).toMatch(/\$env:CODEX_HOME = \$previousConfig|Remove-Item Env:CODEX_HOME/);
  });
});
