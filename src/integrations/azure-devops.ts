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
