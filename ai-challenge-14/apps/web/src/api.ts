import type {
  AcknowledgeResult,
  AvailableTransitions,
  Claim,
  CreateClaimInput,
  TransitionRequest,
  TransitionResult,
  UsersConfig,
  WorkflowConfig,
} from '@claims/engine';

/** Error body of the API (DESIGN 7), plus NETWORK_ERROR / HTTP_<status> when the body isn't one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The claim changed or is locked under the user: show a notice and reload instead of a plain error. */
export function isReloadError(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.code === 'STALE_CLAIM' || error.code === 'CLAIM_BUSY');
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

let currentUserId: string | null = null;

export function setCurrentUser(userId: string | null): void {
  currentUserId = userId;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toApiError(response: Response, body: unknown): ApiError {
  if (typeof body === 'object' && body !== null) {
    const { code, message, details } = body as Record<string, unknown>;
    if (typeof code === 'string' && typeof message === 'string') {
      const detailsObject = typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : null;
      return new ApiError(response.status, code, message, detailsObject);
    }
  }
  return new ApiError(response.status, `HTTP_${response.status}`, response.statusText || 'Request failed', null);
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (currentUserId) headers['X-User-Id'] = currentUserId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError(0, 'NETWORK_ERROR', `Cannot reach the API (${(error as Error).message})`, null);
  }

  const text = await response.text();
  const json = text ? parseJson(text) : undefined;
  if (!response.ok) throw toApiError(response, json);
  return json as T;
}

const claimPath = (id: string) => `/claims/${encodeURIComponent(id)}`;

export const api = {
  getConfig: () => request<WorkflowConfig>('GET', '/config'),
  getUsers: () => request<UsersConfig>('GET', '/users'),
  listClaims: () => request<Claim[]>('GET', '/claims'),
  createClaim: (input: CreateClaimInput) => request<Claim>('POST', '/claims', input),
  getClaim: (id: string) => request<AvailableTransitions>('GET', claimPath(id)),
  transition: (id: string, body: TransitionRequest) =>
    request<TransitionResult>('POST', `${claimPath(id)}/transitions`, body),
  acknowledge: (id: string, body: { notes?: string; expectedVersion?: number }) =>
    request<AcknowledgeResult>('POST', `${claimPath(id)}/acknowledge`, body),
};
