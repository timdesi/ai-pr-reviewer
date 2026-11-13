// Parse a Bitbucket Data Center pull-request reference.
//
// Accepted forms:
//   https://host/projects/PROJ/repos/slug/pull-requests/123/overview
//   https://host/projects/PROJ/repos/slug/pull-requests/123
//   //host/projects/PROJ/repos/slug/pull-requests/123
//   PROJ/slug#123
//   PROJ/slug/123

export function parsePrRef(input) {
  if (!input || typeof input !== "string") {
    throw new Error("Missing pull request reference");
  }
  const raw = input.trim();

  const urlMatch = raw.match(
    /(?:^|\/\/|https?:\/\/[^/]+)\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)/i,
  );
  if (urlMatch) {
    return {
      projectKey: urlMatch[1],
      repoSlug: urlMatch[2],
      prId: Number.parseInt(urlMatch[3], 10),
    };
  }

  const shortWithHash = raw.match(/^([^/#\s]+)\/([^/#\s]+)#(\d+)$/);
  if (shortWithHash) {
    return {
      projectKey: shortWithHash[1],
      repoSlug: shortWithHash[2],
      prId: Number.parseInt(shortWithHash[3], 10),
    };
  }

  const shortSlash = raw.match(/^([^/#\s]+)\/([^/#\s]+)\/(\d+)$/);
  if (shortSlash) {
    return {
      projectKey: shortSlash[1],
      repoSlug: shortSlash[2],
      prId: Number.parseInt(shortSlash[3], 10),
    };
  }

  throw new Error(
    `Unrecognized pull request reference: "${raw}"\n` +
      "Use a PR URL (https://host/projects/KEY/repos/slug/pull-requests/ID) " +
      "or KEY/slug#ID",
  );
}
