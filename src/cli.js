#!/usr/bin/env node
// CLI entry point: trigger a local AI review of a Bitbucket pull request.
//
// Usage:
//   npm run review -- <PR reference> [--publish] [--json]
//
// Examples:
//   npm run review -- https://host/projects/ACME/repos/acme-app/pull-requests/5566
//   npm run review -- ACME/acme-app#5566
//   npm run review -- ACME/acme-app#5566 --publish

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { loadConfig, assertBitbucketConfig } from "./config.js";
import { parsePrRef } from "./prUrl.js";
import { runReview } from "./pipeline.js";
import { initProxy } from "./proxy.js";
import { log } from "./log.js";
import { heading, rule, ui, okBadge, failBadge, severityBadge, padRight, fmtDuration, fmtBytes } from "./ui.js";

function parseArgs(argv) {
  const args = { positional: [], publish: false, json: false, quiet: false, yes: false };
  for (const arg of argv) {
    if (arg === "--publish") args.publish = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--quiet") args.quiet = true;
    else if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else args.positional.push(arg);
  }
  // Accept an optional leading subcommand token (e.g. `review`) so both
  // `node src/cli.js review <PR>` and `node src/cli.js <PR>` work.
  if (args.positional[0] === "review" || args.positional[0] === "help" || args.positional[0] === "fetch") {
    if (args.positional[0] === "help") args.help = true;
    args.positional.shift();
  }
  return args;
}

function printHelp() {
  console.log(
    `AI PR Reviewer — local review trigger

Usage:
  npm run review -- <PR reference> [options]

PR reference is either a Bitbucket URL:
  https://host/projects/KEY/repos/slug/pull-requests/ID[/overview]
or a short form:
  KEY/slug#ID

Options:
  --publish   Post the final report as a PR comment on Bitbucket
  --yes       Skip the confirmation prompt when publishing
  --json      Print the machine-readable result as JSON to stdout
  --quiet     Only stderr logs, no fancy summary
  --help      Show this help

Examples:
  npm run review -- ACME/acme-app#5566
  npm run review -- ACME/acme-app#5566 --publish
`,
  );
}

async function confirmPublish() {
  if (!stdin.isTTY) return false;
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(
    `${ui.yellow("This will post a comment to the real pull request on Bitbucket.")}\n` +
      `Proceed? ${ui.bold("[y/N]")} `,
  );
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function printSummary(result, { startedAt, publish }) {
  const { ref, pullRequest, reviewedSha, reviewers, consensusReport, consensusModel, jobDir, reportMarkdown } = result;
  const durationMs = Date.now() - startedAt;

  console.log("");
  console.log(ui.bold(rule("═")));
  console.log(ui.bold(`  AI Pull Request Review — ${ref.projectKey}/${ref.repoSlug} · PR #${ref.prId}`));
  console.log(ui.bold(rule("═")));
  console.log("");
  console.log(`  ${ui.dim("Title")}     ${pullRequest.title}`);
  console.log(`  ${ui.dim("Branch")}    ${pullRequest.fromRef?.displayId || "?"} @ ${ui.dim(reviewedSha?.slice(0, 12))}`);
  console.log(`  ${ui.dim("Target")}    ${pullRequest.toRef?.displayId || "?"}`);
  console.log(`  ${ui.dim("Author")}   ${pullRequest.author?.user?.displayName || pullRequest.author?.user?.name || "?"}`);
  console.log(`  ${ui.dim("Duration")}  ${fmtDuration(durationMs)}`);
  console.log("");

  console.log(ui.dim(rule("─")));
  console.log(`  ${ui.bold("Agents")}`);
  for (const r of reviewers) {
    const badge = r.ok ? okBadge() : failBadge();
    const status = r.ok
      ? `${badge} ${ui.green("OK")}   ${padRight(fmtDuration(r.durationMs), 9)} ${r.report.findings.length} findings`
      : `${badge} ${ui.red("FAILED")} (${r.error})`;
    console.log(`    ${padRight(r.label, 12)} ${padRight(r.model, 42)} ${status}`);
  }
  console.log(`    ${padRight("Consensus", 12)} ${padRight(consensusModel || "", 42)} ${okBadge()} ${ui.green("OK")}   ${consensusReport.findings.length} findings`);

  console.log("");
  console.log(ui.dim(rule("─")));
  console.log(`  ${ui.bold("Findings by severity")}`);
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of consensusReport.findings || []) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  let total = 0;
  for (const sev of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]) {
    total += counts[sev];
    console.log(`    ${severityBadge(sev)} ${counts[sev]}`);
  }
  console.log(`    ${ui.dim("Total")}         ${total}`);
  console.log("");

  console.log(ui.dim(rule("─")));
  console.log(`  ${ui.bold("Summary")}`);
  const summary = (consensusReport.summary || "").replace(/\n+/g, " ").trim();
  console.log(wrap(summary || "(no summary)", 4, 76));
  console.log("");

  console.log(ui.dim(rule("─")));
  console.log(`  ${ui.bold("Artifacts")}`);
  const size = Buffer.byteLength(reportMarkdown, "utf8");
  console.log(`    Report file   ${ui.cyan(`${jobDir}/final-report.md`)} (${fmtBytes(size)})`);
  console.log(`    Job artifacts ${ui.dim(jobDir)}`);
  console.log("");

  const p = result.publish;
  if (p.published) {
    console.log(`  ${ui.green("✔ Published")} comment ${ui.bold(`#${p.commentId}`)}`);
    console.log(`    ${ui.cyan(p.url)}`);
  } else {
    const why = p.stale ? ui.yellow("skipped — PR head changed during review") : "";
    console.log(`  ${ui.dim("Publication")}  ${ui.yellow("dry run")} — draft kept at ${ui.cyan(`${jobDir}/comment-draft.md`)} ${why}`);
  }
  console.log("");
  console.log(ui.bold(rule("═")));
  console.log("");
}

function wrap(text, indent, width) {
  const prefix = " ".repeat(indent);
  const words = text.split(/\s+/);
  const lines = [];
  let line = prefix;
  for (const word of words) {
    if (line.length + word.length + 1 > width && line.length > prefix.length) {
      lines.push(line);
      line = prefix + word;
    } else {
      line += (line.length === prefix.length ? "" : " ") + word;
    }
  }
  if (line.trim()) lines.push(line);
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  await initProxy();

  if (!args.positional.length) {
    console.error("Missing pull request reference. Run with --help for usage.");
    process.exitCode = 2;
    return;
  }
  if (args.positional.length > 1) {
    console.error(`Unexpected extra arguments: ${args.positional.slice(1).join(" ")}`);
    process.exitCode = 2;
    return;
  }

  let config;
  try {
    config = loadConfig();
    assertBitbucketConfig(config);
  } catch (err) {
    console.error(err.message);
    console.error("Copy .env.example to .env and fill in BITBUCKET_BASE_URL / BITBUCKET_API_TOKEN.");
    process.exitCode = 2;
    return;
  }

  let ref;
  try {
    ref = parsePrRef(args.positional[0]);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }

  // Publishing happens when --publish is given, or PUBLISH_TO_BITBUCKET=true in .env.
  const publish = args.publish || !config.job.dryRun;

  const startedAt = Date.now();
  const stages = { fetch: "Fetching PR details", review: "Running reviewers in parallel", consensus: "Consensus", render: "Rendering report", publish: "Publishing" };

  if (publish && !args.yes) {
    const proceed = await confirmPublish();
    if (!proceed) {
      console.log("Aborted — no comment was posted.");
      return;
    }
  }

  try {
    const result = await runReview({
      ref,
      config,
      options: {
        publish,
        onStage: (stage) => {
          if (args.quiet) return;
          const label = stages[stage] || stage;
          if (process.stderr.isTTY) {
            process.stderr.write(`\r\x1b[2K${ui.dim(`▸ ${label}...`)}`);
          } else {
            log.info(`▸ ${label}...`);
          }
        },
      },
    });

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            ref,
            jobDir: result.jobDir,
            reviewedSha: result.reviewedSha,
            reviewers: result.reviewers.map((r) => ({
              label: r.label,
              model: r.model,
              ok: r.ok,
              attempt: r.attempt,
              durationMs: r.durationMs,
              findings: r.report?.findings?.length ?? null,
              error: r.error,
            })),
            consensus: {
              schema_version: result.consensusReport.schema_version,
              summary: result.consensusReport.summary,
              findings: result.consensusReport.findings,
              notes: result.consensusReport.notes,
            },
            reportMarkdown: result.reportMarkdown,
            publish: result.publish,
            durationMs: Date.now() - startedAt,
          },
          null,
          2,
        ),
      );
    } else if (!args.quiet) {
      printSummary(result, { startedAt, publish });
    }
  } catch (err) {
    console.error(heading("Review failed"));
    console.error(`  ${ui.red(err.message)}`);
    if (!args.quiet) console.error(ui.dim(rule("─")));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});