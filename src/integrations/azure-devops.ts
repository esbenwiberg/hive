import logger from "../logger.js";

const API_VERSION = "7.1";

interface AzureDevOpsPR {
  id: number;
  url: string;
  status: string;
}

/**
 * Parses an Azure DevOps repo full name into its components.
 * Format: "org/project/repo"
 */
export function parseAdoRepoName(fullName: string): { org: string; project: string; repo: string } {
  const parts = fullName.split("/");
  if (parts.length !== 3) {
    throw new Error(`Invalid Azure DevOps repo name: ${fullName}. Expected format: org/project/repo`);
  }
  return { org: parts[0], project: parts[1], repo: parts[2] };
}

/**
 * Creates a pull request in Azure DevOps.
 */
export async function createPullRequest(
  org: string,
  project: string,
  repo: string,
  sourceBranch: string,
  targetBranch: string,
  title: string,
  description: string,
  pat: string,
): Promise<{ id: number; url: string }> {
  const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?api-version=${API_VERSION}`;

  const body = {
    sourceRefName: `refs/heads/${sourceBranch.replace(/^refs\/heads\//, "")}`,
    targetRefName: `refs/heads/${targetBranch.replace(/^refs\/heads\//, "")}`,
    title,
    description,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Azure DevOps PR creation failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { pullRequestId: number; repository: { webUrl: string } };

  const prUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${data.pullRequestId}`;

  logger.info({ org, project, repo, prId: data.pullRequestId }, "Azure DevOps PR created");

  return { id: data.pullRequestId, url: prUrl };
}

/**
 * Lists pull requests matching a source branch.
 * Used to find an existing PR when creation returns 409.
 */
export async function listPullRequests(
  org: string,
  project: string,
  repo: string,
  sourceBranch: string,
  pat: string,
): Promise<Array<{ id: number; url: string; status: string }>> {
  const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?searchCriteria.sourceRefName=refs/heads/${encodeURIComponent(sourceBranch.replace(/^refs\/heads\//, ""))}&searchCriteria.status=active&api-version=${API_VERSION}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Azure DevOps list PRs failed (${response.status}): ${text}`);
  }

  const data = await response.json() as {
    value: Array<{ pullRequestId: number; status: string }>;
  };

  return data.value.map((pr) => ({
    id: pr.pullRequestId,
    url: `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${pr.pullRequestId}`,
    status: pr.status,
  }));
}

/**
 * Creates a comment thread on a pull request in Azure DevOps.
 */
export async function createPRComment(
  org: string,
  project: string,
  repo: string,
  prId: number,
  comment: string,
  pat: string,
): Promise<void> {
  const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}/threads?api-version=${API_VERSION}`;

  const body = {
    comments: [{ parentCommentId: 0, content: comment, commentType: 1 }],
    status: 1, // active
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Azure DevOps PR comment failed (${response.status}): ${text}`);
  }

  logger.info({ org, project, repo, prId }, "Azure DevOps PR comment created");
}

/**
 * Gets a pull request by ID.
 */
export async function getPullRequest(
  org: string,
  project: string,
  repo: string,
  prId: number,
  pat: string,
): Promise<AzureDevOpsPR> {
  const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}?api-version=${API_VERSION}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Azure DevOps get PR failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { pullRequestId: number; status: string };
  const prUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${data.pullRequestId}`;

  return { id: data.pullRequestId, url: prUrl, status: data.status };
}

// ── Work Item APIs ──────────────────────────────────────────────────────────

interface WiqlResult {
  workItems: Array<{ id: number; url: string }>;
}

interface WorkItemFields {
  "System.Id": number;
  "System.Title": string;
  "System.Description"?: string;
  "System.WorkItemType": string;
  "System.State": string;
  "System.Tags"?: string;
  [key: string]: unknown;
}

interface WorkItemResponse {
  id: number;
  fields: WorkItemFields;
  url: string;
}

/**
 * Queries work items using WIQL (Work Item Query Language).
 * Returns an array of work item IDs matching the query.
 */
export async function queryWorkItems(
  org: string,
  project: string,
  wiql: string,
  pat: string,
  top?: number,
): Promise<Array<{ id: number }>> {
  const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=${API_VERSION}${top ? `&$top=${top}` : ""}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
    },
    body: JSON.stringify({ query: wiql }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Azure DevOps WIQL query failed (${response.status}): ${text}`);
  }

  const data = await response.json() as WiqlResult;
  return data.workItems.map((wi) => ({ id: wi.id }));
}

/**
 * Gets a single work item by ID with all fields.
 */
export async function getWorkItem(
  org: string,
  project: string,
  id: number,
  pat: string,
): Promise<WorkItemResponse> {
  const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems/${id}?$expand=all&api-version=${API_VERSION}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Azure DevOps get work item failed (${response.status}): ${text}`);
  }

  return await response.json() as WorkItemResponse;
}

/**
 * Updates tags on a work item using JSON Patch.
 * Adds `addTags` and removes `removeTags` from the existing tag list.
 */
export async function updateWorkItemTags(
  org: string,
  project: string,
  id: number,
  addTags: string[],
  removeTags: string[],
  pat: string,
): Promise<void> {
  // First get current tags
  const wi = await getWorkItem(org, project, id, pat);
  const currentTags = (wi.fields["System.Tags"] ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);

  // Remove specified tags, add new ones
  const updatedTags = currentTags
    .filter((t) => !removeTags.some((r) => r.toLowerCase() === t.toLowerCase()));
  for (const tag of addTags) {
    if (!updatedTags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      updatedTags.push(tag);
    }
  }

  const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json-patch+json",
      Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
    },
    body: JSON.stringify([
      {
        op: "replace",
        path: "/fields/System.Tags",
        value: updatedTags.join("; "),
      },
    ]),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Azure DevOps update work item tags failed (${response.status}): ${text}`);
  }

  logger.info({ org, project, id, addTags, removeTags }, "Azure DevOps work item tags updated");
}

/**
 * Gets all comments from PR threads in Azure DevOps.
 * Flattens thread comments into a flat list.
 */
export async function getPRThreadComments(
  org: string,
  project: string,
  repo: string,
  prId: number,
  pat: string,
): Promise<Array<{ id: number; body: string; author: string; createdAt: string }>> {
  const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}/threads?api-version=${API_VERSION}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Azure DevOps get PR threads failed (${response.status}): ${text}`);
  }

  const data = await response.json() as {
    value: Array<{
      comments: Array<{
        id: number;
        content: string;
        author: { displayName: string };
        publishedDate: string;
      }>;
    }>;
  };

  const result: Array<{ id: number; body: string; author: string; createdAt: string }> = [];
  for (const thread of data.value) {
    for (const comment of thread.comments) {
      if (!comment.content) continue;
      result.push({
        id: comment.id,
        body: comment.content,
        author: comment.author?.displayName ?? "unknown",
        createdAt: comment.publishedDate,
      });
    }
  }

  return result;
}
