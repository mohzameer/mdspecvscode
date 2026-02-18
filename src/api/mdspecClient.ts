import * as vscode from 'vscode';

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
  updated_at: string;
  project_id: string;
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
    return vscode.workspace.getConfiguration('mdspec').get<string>('apiBaseUrl', 'https://mdspec.dev/api');
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
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const text = await response.text();
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

  async listSpecs(token: string): Promise<ListSpecsResponse> {
    return this.request<ListSpecsResponse>('GET', '/public/specs', token);
  }

  async getSpec(token: string, slug: string): Promise<GetSpecResponse> {
    return this.request<GetSpecResponse>(
      'GET',
      `/public/specs/${encodeURIComponent(slug)}`,
      token
    );
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
