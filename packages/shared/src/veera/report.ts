/**
 * Veera T2 — Markdown report generator (JES-153).
 *
 * Renders FROM the audit JSON ONLY. There is no second hand-edited verdict:
 * the report is a pure function of (audit, eligibility result). It never
 * upgrades HOLD to PASS and never invents findings.
 */

import type { RequirementsAudit, ValidationResult } from "./types.js";

export interface ReportInputs {
  audit: RequirementsAudit;
  result: ValidationResult;
}

function esc(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderAuditReport({ audit, result }: ReportInputs): string {
  const lines: string[] = [];
  const verdict = result.eligible ? "ELIGIBLE" : "HOLD";
  const counts = new Map<string, number>();
  for (const f of audit.findings) {
    counts.set(f.result, (counts.get(f.result) ?? 0) + 1);
  }

  lines.push(`# Veera audit report — ${esc(audit.deliveryId)}`);
  lines.push("");
  lines.push(`- Checkpoint: ${audit.checkpoint}`);
  lines.push(`- Verdict: **${verdict}**`);
  if (audit.attempt !== undefined) lines.push(`- Attempt: ${audit.attempt}`);
  lines.push(`- Contract hash: \`${audit.contractRef.contractHash}\``);
  if (audit.candidate !== undefined) {
    lines.push(`- Candidate: \`${esc(audit.candidate.repo)} @ ${audit.candidate.sha}\``);
  }
  if (audit.planRef !== undefined) {
    lines.push(
      `- Plan: revision \`${esc(audit.planRef.planRevision)}\` hash \`${audit.planRef.planHash}\``,
    );
  }
  lines.push(
    `- Source completeness: ${audit.sourceCompleteness.accepted ? "accepted" : "NOT accepted"} by ${esc(audit.sourceCompleteness.verifierRole)}`,
  );
  lines.push(
    `- Findings: ${audit.findings.length} total` +
      ` (PASS ${counts.get("PASS") ?? 0}, PARTIAL ${counts.get("PARTIAL") ?? 0}, MISSING ${counts.get("MISSING") ?? 0}, UNCERTAIN ${counts.get("UNCERTAIN") ?? 0})`,
  );
  lines.push("");

  if (result.failures.length > 0) {
    lines.push("## Eligibility failures (validator, PRD section 8)");
    lines.push("");
    lines.push("| Case | Code | Detail |");
    lines.push("| --- | --- | --- |");
    for (const f of result.failures) {
      lines.push(`| ${f.case} | \`${esc(f.code)}\` | ${esc(f.message)} |`);
    }
    lines.push("");
  }

  lines.push("## Per-requirement findings");
  lines.push("");
  lines.push("| Requirement | Result | Evidence | Note |");
  lines.push("| --- | --- | --- | --- |");
  const sorted = [...audit.findings].sort((a, b) =>
    a.requirementId < b.requirementId ? -1 : a.requirementId > b.requirementId ? 1 : 0,
  );
  for (const f of sorted) {
    const evCount = f.evidence?.length ?? 0;
    lines.push(
      `| \`${esc(f.requirementId)}\` | ${f.result} | ${evCount} item(s) | ${esc(f.note ?? "")} |`,
    );
  }
  lines.push("");

  const nonPass = sorted.filter((f) => f.result !== "PASS");
  if (nonPass.length > 0) {
    lines.push("## Next actions");
    lines.push("");
    for (const f of nonPass) {
      const owner =
        f.result === "UNCERTAIN"
          ? "QA or evidence producer"
          : f.result === "MISSING"
            ? "engineer correction"
            : "engineer correction";
      lines.push(
        `- ${f.result} \`${esc(f.requirementId)}\` → ${owner}${f.note ? `: ${esc(f.note)}` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push(
    "_Generated deterministically from the audit JSON only; not a second verdict._",
  );
  lines.push("");
  return lines.join("\n");
}
