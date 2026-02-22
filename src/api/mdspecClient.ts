import { API_BASE_URL } from '../utils/constants';

export interface LoginResponse {
  user: {
    id: string;
    email: string;
  };
  session: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  };
}

export interface SpecEntry {
  id: string;
  name: string;
  slug: string;
  file_name?: string | null;
  updated_at: string;
  project_id: string;
  is_linked?: boolean;
  /** Set for linked specs: id of the source spec. DELETE unlink must use this spec's `id` (proxy id), not source_spec_id. */
  source_spec_id?: string | null;
  latest_revision?: {
    revision_number: number;
    content_hash: string;
    created_at: string;
  };
}

export interface ListSpecsResponse {
  specs: SpecEntry[];
}

export interface CreateSpecResponse {
  success: boolean;
  spec: {
    id: string;
    slug: string;
    name: string;
    latest_revision_number: number;
  };
}

export interface GetSpecResponse {
  spec: {
    id: string;
    name: string;
    slug: string;
    updated_at: string;
    project_id: string;
    is_linked?: boolean;
    latest_revision?: {
      revision_number: number;
      content_hash: string;
      created_at: string;
    };
  };
  content: string;
}

export interface UploadRevisionResponse {
  success?: boolean;
  message?: string;
  revision?: {
    revision_number: number;
    content_hash: string;
    created_at: string;
  };
  revision_number?: number;
}

export class MdspecApiError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'MdspecApiError';
  }
}

export class MdspecClient {
  private getBaseUrl(): string {
    return API_BASE_URL;
  }

  private async request<T>(
    method: string,
    path: string,
    token?: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.getBaseUrl()}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const options: RequestInit = {
      method,
      headers,
    };

    if (body) {
      options.body = JSON.stringify(body);
      console.log(`[mdspec] Request body:`, JSON.stringify(body, null, 2));
    }

    console.log(`[mdspec] ${method} ${url}`);

    const response = await fetch(url, options);

    console.log(`[mdspec] ${method} ${url} → ${response.status}`);

    if (!response.ok) {
      const text = await response.text();
      console.error(`[mdspec] Error body: ${text}`);
      throw new MdspecApiError(response.status, text || `HTTP ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    return this.request<LoginResponse>('POST', '/public/auth/login', undefined, {
      email,
      password,
    });
  }

  async refreshSession(refreshToken: string): Promise<LoginResponse> {
    return this.request<LoginResponse>('POST', '/public/auth/refresh', undefined, {
      refresh_token: refreshToken,
    });
  }

  /** List specs. Omit projectSlug to get specs from all projects. */
  async listSpecs(token: string, projectSlug?: string): Promise<ListSpecsResponse> {
    const path = projectSlug
      ? `/public/specs?project_slug=${encodeURIComponent(projectSlug)}`
      : '/public/specs';
    return this.request<ListSpecsResponse>('GET', path, token);
  }

  async getSpec(token: string, slug: string, projectId?: string): Promise<GetSpecResponse> {
    let path = `/public/specs/${encodeURIComponent(slug)}`;
    if (projectId) {
      path += `?project_id=${encodeURIComponent(projectId)}`;
    }
    console.log(`[mdspec] getSpec slug=${slug}, project_id=${projectId ?? 'none'}`);
    return this.request<GetSpecResponse>('GET', path, token);
  }

  /** Get spec by id (uuid). Use for link flow when slug is ambiguous across projects. */
  async getSpecById(token: string, specId: string): Promise<GetSpecResponse> {
    const path = `/public/specs/${encodeURIComponent(specId)}`;
    console.log(`[mdspec] getSpecById specId=${specId}`);
    return this.request<GetSpecResponse>('GET', path, token);
  }

  /** Remove a linked spec. Accepts proxy id, source spec id, or slug. Pass project_slug or project_id when source is linked in multiple projects. */
  async deleteLinkedSpec(
    token: string,
    slugOrIdOrSourceId: string,
    options?: { project_slug?: string; project_id?: string }
  ): Promise<{ success: boolean; message?: string }> {
    let path = `/public/specs/${encodeURIComponent(slugOrIdOrSourceId)}`;
    if (options?.project_id) {
      path += `?project_id=${encodeURIComponent(options.project_id)}`;
    } else if (options?.project_slug) {
      path += `?project_slug=${encodeURIComponent(options.project_slug)}`;
    }
    return this.request('DELETE', path, token);
  }

  async createSpec(
    token: string,
    params: {
      name: string;
      content: string;
      file_name?: string;
      project_slug?: string;
      org_slug?: string;
      project_id?: string;
      slug?: string;
    }
  ): Promise<CreateSpecResponse> {
    return this.request<CreateSpecResponse>('POST', '/public/specs', token, params);
  }

  async uploadRevision(
    token: string,
    slug: string,
    params: { content: string; summary?: string }
  ): Promise<UploadRevisionResponse> {
    return this.request<UploadRevisionResponse>(
      'POST',
      `/public/specs/${encodeURIComponent(slug)}/revisions`,
      token,
      params
    );
  }
}
