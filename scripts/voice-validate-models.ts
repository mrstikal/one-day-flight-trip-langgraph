import { readFileSync } from "node:fs";
import { voiceProfilesFileSchema } from "@odft/contracts";
import { resolveRepoConfigPath } from "@odft/ai";
import { parseServerConfig } from "@odft/persistence";
import { loadLocalEnv } from "./_load-env.js";

/**
 * `npm run voice:validate-models` (VOICE_CONTROLL.md section 6; task V01/V02).
 *
 * V01 skeleton: resolves and strictly validates the local `voice-profiles.json`
 * operator file and prints a secret-free summary, then fails closed because the
 * live capability/endpoint/pricing validation and capability-cache stamping are
 * not implemented yet (planned V02). It never claims provider enforcement and
 * never stamps `pricingVersion`.
 */

function formatIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string {
  return issues
    .map(
      (issue) =>
        `${issue.path.map((part) => String(part)).join(".") || "(root)"}: ${issue.message}`,
    )
    .join("\n- ");
}

async function main(): Promise<void> {
  // Load .env/.env.local exactly like the other operational scripts, so the
  // documented "set the values in .env and run the command" flow works.
  loadLocalEnv();
  const config = parseServerConfig(process.env);
  if (config.aiMode !== "openrouter") {
    throw new Error(
      "AI_MODE=openrouter is required to validate live speech models (see README: AI modes and configuration)",
    );
  }
  if (!config.voiceConfigPath) {
    throw new Error(
      "VOICE_CONFIG_PATH is required to validate speech models; copy voice-profiles.example.json to a git-ignored voice-profiles.json and point VOICE_CONFIG_PATH at it",
    );
  }
  // Resolve like the web app/worker (cwd, then repo root) so the documented
  // relative path works from every start location.
  const resolvedConfigPath = resolveRepoConfigPath(config.voiceConfigPath, "VOICE_CONFIG_PATH");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolvedConfigPath, "utf8"));
  } catch (error) {
    throw new Error(
      `VOICE_CONFIG_PATH could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = voiceProfilesFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid voice profile file:\n- ${formatIssues(parsed.error.issues)}`);
  }
  const profiles = parsed.data;
  console.log(
    `voice profile file ok: schemaVersion=${profiles.schemaVersion}, pricingVersion=${profiles.pricingVersion}`,
  );
  console.log(
    `stt: model=${profiles.stt.model} endpointProviderId=${profiles.stt.endpointProviderId} timeoutMs=${profiles.stt.timeoutMs} maxCallCostUsd=${profiles.stt.maxCallCostUsd}`,
  );
  console.log(
    `tts: model=${profiles.tts.model} voice=${profiles.tts.voice} responseFormat=${profiles.tts.responseFormat} timeoutMs=${profiles.tts.timeoutMs} maxCallCostUsd=${profiles.tts.maxCallCostUsd}`,
  );
  console.log(
    `limits: maxRecordingSeconds=${profiles.limits.maxRecordingSeconds} maxRequestAudioBytes=${profiles.limits.maxRequestAudioBytes} maxResponseAudioBytes=${profiles.limits.maxResponseAudioBytes} maxTranscriptCharacters=${profiles.limits.maxTranscriptCharacters} maxReplyCharacters=${profiles.limits.maxReplyCharacters} maxCallsPerTrip=${profiles.limits.maxCallsPerTrip} maxCostUsdPerTrip=${profiles.limits.maxCostUsdPerTrip}`,
  );
  if (!config.openrouterSttApiKey) {
    console.warn(
      "warning: OPENROUTER_STT_API_KEY is not set; live STT would refuse transport until the dedicated Groq-restricted key is configured",
    );
  }
  throw new Error(
    "capability/endpoint/pricing validation and capabilities-cache stamping are not implemented yet (planned V02); pricingVersion was not stamped",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
