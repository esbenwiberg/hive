import { DefaultAzureCredential } from "@azure/identity";
import logger from "../logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface AzureMonitorConfig {
  workspaceId: string;
}

interface KqlColumn {
  name: string;
  type: string;
}

interface KqlTable {
  columns: KqlColumn[];
  rows: unknown[][];
}

interface KqlResponse {
  tables: KqlTable[];
}

// ── KQL query runner ────────────────────────────────────────────────────────

export async function runKqlQuery(
  config: AzureMonitorConfig,
  kql: string,
  timespan?: string,
): Promise<Array<Record<string, unknown>>> {
  if (!process.env.AZURE_MONITOR_WORKSPACE_ID) {
    logger.warn("AZURE_MONITOR_WORKSPACE_ID not set — skipping KQL query");
    return [];
  }

  try {
    const credential = new DefaultAzureCredential();
    const tokenResponse = await credential.getToken(
      "https://api.loganalytics.io/.default",
    );

    const url = `https://api.loganalytics.io/v1/workspaces/${encodeURIComponent(config.workspaceId)}/query`;

    const body: Record<string, string> = { query: kql };
    if (timespan) {
      body.timespan = timespan;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenResponse.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error(
        { status: response.status, body: text },
        "Azure Monitor query failed",
      );
      return [];
    }

    const data = (await response.json()) as KqlResponse;

    if (!data.tables || data.tables.length === 0) {
      return [];
    }

    const table = data.tables[0];
    const columnNames = table.columns.map((c) => c.name);

    return table.rows.map((row) => {
      const record: Record<string, unknown> = {};
      for (let i = 0; i < columnNames.length; i++) {
        record[columnNames[i]] = row[i];
      }
      return record;
    });
  } catch (err: unknown) {
    logger.error({ err }, "Azure Monitor KQL query error");
    return [];
  }
}
