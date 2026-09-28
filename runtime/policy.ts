import type { State } from './state';

type AuthorizationKind = 'compute' | 'publish';

const PUBLIC_REPO = /^hf:\/\/(models|datasets|spaces|buckets)\/[^/]+\/[^/]+$/;

export function validateAuthorization(kind: AuthorizationKind, scope: string): string {
  const value = scope.trim();
  if (kind === 'publish') {
    if (!PUBLIC_REPO.test(value)) throw Error('Publication scope must be one exact hf:// repo URI.');
    return value;
  }
  if (value.toLowerCase() === 'standing') return 'standing';
  const slug = allowanceSlug(value);
  if (slug.length < 3) throw Error('Compute scope must produce an experiment slug of at least three characters.');
  return value;
}

export function allowanceSlug(scope: string): string {
  return scope.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function recordAuthorization(state: State, kind: AuthorizationKind, scope: string): string {
  const value = validateAuthorization(kind, scope);
  if (kind === 'publish') state.publications = [...new Set([...state.publications, value])];
  else state.allowance = value;
  return value;
}

export function paidOperation(toolName: string, input: Record<string, any>): boolean {
  return (toolName === 'hf_jobs' && ['run', 'uv'].includes(input.operation))
    || (toolName === 'hf_sandbox' && input.cmd === 'create')
    || (toolName === 'create_repo' && /^hf:\/\/(spaces|buckets)\//.test(input.uri));
}

/** Names tie each paid submission to the recorded experiment; this is not a monetary cap. */
export function paidResourceName(toolName: string, input: Record<string, any>): string | undefined {
  if (toolName === 'hf_jobs' && ['run', 'uv'].includes(input.operation)) return input.args?.name;
  if (toolName === 'hf_sandbox' && input.cmd === 'create') {
    const args = input.args;
    return Array.isArray(args) && args.indexOf('--name') >= 0 ? args[args.indexOf('--name') + 1] : undefined;
  }
  if (toolName === 'create_repo' && /^hf:\/\/(spaces|buckets)\//.test(input.uri)) return input.uri.split('/').at(-1);
}

export function matchesAllowance(scope: string, name: unknown): boolean {
  if (typeof name !== 'string' || !name.trim()) return false;
  if (scope.toLowerCase().trim() === 'standing') return true;
  const prefix = allowanceSlug(scope);
  return prefix.length >= 3 && (name.toLowerCase() === prefix || name.toLowerCase().startsWith(prefix + '-'));
}

export function sandboxGrammarError(toolName: string, input: Record<string, any>, handle?: string): string | undefined {
  if (!['hf_sandbox', 'hf_sandbox_exec', 'hf_sandbox_fs'].includes(toolName)) return;
  if (!Array.isArray(input.args) || input.args[0] !== input.cmd)
    return `Use the captured sandbox grammar: args[0] must repeat cmd (${JSON.stringify(input.cmd)}).`;
  if (handle !== undefined && input.args[1] !== handle)
    return 'Use the sandbox handle supplied by the parent as args[1], immediately after the command token.';
}

export function authorizationPrompt(kind: AuthorizationKind, scope: string, reason: string, estimate?: string): {title: string; message: string} {
  if (kind === 'publish') return {
    title: 'Authorize public artifact?',
    message: `Publish exactly ${scope}?\n\n${reason}\n\nThis is an artifact-scoped exception to private-by-default output.`,
  };
  return {
    title: 'Authorize paid ML resources?',
    message: `Allow experiment scope ${JSON.stringify(scope)}?\n\n${reason}${estimate ? `\n\nEstimated cost/time: ${estimate}` : ''}\n\nThis covers its checks, smoke tests, failures, retries, and real run. It is not a hard spending cap.`,
  };
}
