import { getSecret } from "./vault/keyvault.js";
import logger from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface NotificationPayload {
  title: string;
  body: string;
  taskIds?: string[];
  producerName?: string;
  repoName?: string;
}

// ── Core sender ─────────────────────────────────────────────────────────────

export async function sendNotification(
  payload: NotificationPayload,
): Promise<void> {
  const [slackUrl, teamsUrl] = await Promise.all([
    getSecret("hive-slack-webhook"),
    getSecret("hive-teams-webhook"),
  ]);

  if (!slackUrl && !teamsUrl) {
    logger.debug("No notification webhooks configured — skipping");
    return;
  }

  const sends: Promise<void>[] = [];

  if (slackUrl) {
    sends.push(
      fetch(slackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `*${payload.title}*\n${payload.body}` }),
      })
        .then((resp) => {
          if (!resp.ok) {
            logger.warn({ status: resp.status }, "Slack webhook returned non-OK status");
          } else {
            logger.info("Slack notification sent");
          }
        })
        .catch((err: unknown) => {
          logger.error({ err }, "Failed to send Slack notification");
        }),
    );
  }

  if (teamsUrl) {
    sends.push(
      fetch(teamsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          "@type": "MessageCard",
          "@context": "http://schema.org/extensions",
          summary: payload.title,
          text: payload.body,
        }),
      })
        .then((resp) => {
          if (!resp.ok) {
            logger.warn({ status: resp.status }, "Teams webhook returned non-OK status");
          } else {
            logger.info("Teams notification sent");
          }
        })
        .catch((err: unknown) => {
          logger.error({ err }, "Failed to send Teams notification");
        }),
    );
  }

  await Promise.all(sends);
}

// ── Convenience wrappers ────────────────────────────────────────────────────

export async function notifyTasksCreated(
  producerName: string,
  repoName: string,
  taskTitles: string[],
  taskIds: string[],
): Promise<void> {
  const count = taskTitles.length;
  const list = taskTitles.map((t, i) => taskIds[i] ? `  - ${t} (${taskIds[i]})` : `  - ${t}`).join("\n");
  const body = `Producer "${producerName}" created ${count} task(s) in ${repoName}:\n${list}`;

  await sendNotification({
    title: `${count} new task(s) from ${producerName}`,
    body,
    taskIds,
    producerName,
    repoName,
  });
}
