import { createBrokerBusinessDataPreviewClient } from './forge-business-data-preview.mjs';
import { MANAGED_FILES_ACTION, MANAGED_FILE_TOOL, validateManagedFileArguments, managedFileError } from './forge-managed-files.mjs';

export function createManagedFileClient(options = {}) {
  return createBrokerBusinessDataPreviewClient({ ...options, action: MANAGED_FILES_ACTION });
}

export function registerManagedFileTool(ctx, defineTool, { resolveContext, client } = {}) {
  ctx.tools.register(defineTool({
    name: MANAGED_FILE_TOOL,
    description: 'Read or maintain ordinary text/HTML files in an operator-registered local server directory. targets lists this account’s configured targets. Every file operation requires this direct user request to name the server directory and action. Read first; write/remove/restore require its exact version (absent for a new file). Each mutation returns a recoverable revision. No shell, remote SSH, registration, database/system/credential files or recursive deletion.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['targets', 'read', 'write', 'remove', 'restore'] },
      targetId: { type: 'string', description: 'Registered target ID from targets.' },
      relativePath: { type: 'string', description: 'Exact ordinary file relative to that target; parent directories must already exist.' },
      content: { type: 'string', description: 'Complete UTF-8 text for write; at most 256 KiB.' },
      expectedVersion: { type: 'string', description: 'Version from read, or absent for creation.' },
      revisionId: { type: 'string', description: 'Original revision returned for this same file/account; restore only.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      const normalized = validateManagedFileArguments(args);
      if (typeof client !== 'function') managedFileError('MANAGED_FILE_UNAVAILABLE', 'The registered-directory Broker is unavailable.');
      if (args.operation === 'targets') return client({ action: MANAGED_FILES_ACTION, operation: 'targets' });
      const context = await resolveContext?.(exec);
      if (!context || context.dshSessionId !== exec?.agent?.session?.id) managedFileError('MANAGED_FILE_CONTEXT', 'The current protected conversation request is required.');
      return client({ action: MANAGED_FILES_ACTION, ...normalized,
        lookup: Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId', 'rpcId', 'textDigest'].map(key => [key, context[key]])),
        expectedExecutionId: context.executionId, expectedGeneration: context.generation,
      });
    },
  }));
}
