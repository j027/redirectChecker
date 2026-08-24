import { Page, Request, Response } from "patchright";

export interface CapturedRequest {
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  location: string | null;
  setCookie: string | null;
  postData: string | null;
}

export interface RequestLogger {
  entries: CapturedRequest[];
  detach(): void;
}

export async function attachRequestLogger(page: Page): Promise<RequestLogger> {
  const entries: CapturedRequest[] = [];
  const requestToEntry = new WeakMap<Request, CapturedRequest>();

  const requestListener = (request: Request) => {
    let postData: string | null = null;
    try {
      postData = request.postData();
    } catch {
      postData = null;
    }

    const entry: CapturedRequest = {
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      status: null,
      location: null,
      setCookie: null,
      postData,
    };
    entries.push(entry);
    requestToEntry.set(request, entry);
  };

  const responseListener = (response: Response) => {
    const entry = requestToEntry.get(response.request());
    if (entry == null) {
      return;
    }
    try {
      const headers = response.headers();
      entry.status = response.status();
      entry.location = headers["location"] ?? null;
      entry.setCookie = headers["set-cookie"] ?? null;
    } catch {
      // keep whatever we already have
    }
  };

  page.on("request", requestListener);
  page.on("response", responseListener);

  return {
    entries,
    detach: () => {
      page.off("request", requestListener);
      page.off("response", responseListener);
    },
  };
}

const MAX_BODY_PREVIEW = 4000;

function prettyPrintPostBody(postData: string | null): string | null {
  if (postData == null || postData.length === 0) {
    return null;
  }
  try {
    const params = new URLSearchParams(postData);
    const data = params.get("data");
    if (data != null) {
      return JSON.stringify(JSON.parse(data), null, 2);
    }
  } catch {
    // fall through to raw body
  }
  return postData;
}

export function formatRequestLog(requests: CapturedRequest[]): string {
  const lines: string[] = [];

  requests.forEach((request, index) => {
    const isBlocked =
      request.status == null &&
      ["image", "font", "stylesheet", "media"].includes(request.resourceType);
    if (isBlocked) {
      return;
    }

    const status = request.status != null ? ` ${request.status}` : "";
    lines.push(
      `${index + 1}. ${request.method}${status} ${request.url} (${request.resourceType})`,
    );

    if (request.location != null) {
      lines.push(`   -> location: ${request.location}`);
    }
    if (request.setCookie != null) {
      lines.push(`   -> set-cookie: ${request.setCookie}`);
    }

    const body = prettyPrintPostBody(request.postData);
    if (body != null) {
      lines.push(`   -> body:`);
      const preview = body.slice(0, MAX_BODY_PREVIEW);
      for (const bodyLine of preview.split("\n")) {
        lines.push(`      ${bodyLine}`);
      }
      if (body.length > MAX_BODY_PREVIEW) {
        lines.push(`      ... (truncated, ${body.length} chars total)`);
      }
    }
  });

  return lines.join("\n");
}
