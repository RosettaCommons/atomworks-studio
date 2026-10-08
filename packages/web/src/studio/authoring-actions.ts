import { api, ApiError } from "../api.ts";
import { confirmAction } from "../confirmation.ts";
import type { StructureSummary } from "../types.ts";

export interface ValidatedExport {
  cif: string;
  name: string;
  revision: number;
  issues: StructureSummary["validation"];
}

export async function prepareCifDownload(
  sessionId: string,
  isCurrent: () => boolean,
  confirm = confirmAction,
): Promise<ValidatedExport | null> {
  const result = await api<ValidatedExport>(`/api/sessions/${sessionId}/export`, {
    method: "POST",
    timeoutMs: 150_000,
  });
  if (!isCurrent()) return null;
  if (result.issues.length && !await confirm(
    "Validation issues found:\n\n"
    + result.issues.map((issue) => `• [${issue.check}] ${issue.message}`).join("\n")
    + "\n\nSave anyway?", "Save anyway", "Validation findings",
  )) return null;
  return isCurrent() ? result : null;
}

export async function mutateWithConfirmation<T>(
  path: string,
  body: unknown,
  isCurrent: () => boolean,
  confirm = confirmAction,
): Promise<T | null> {
  const request = {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  try {
    return await api<T>(path, request);
  } catch (error) {
    const detail = error instanceof ApiError
      ? (error.detail as { detail?: { code?: string; lost_target_count?: number; revision?: number } })?.detail
      : undefined;
    if (!(error instanceof ApiError) || error.status !== 409
      || detail?.code !== "target_discard_confirmation_required"
      || !Number.isInteger(detail.lost_target_count) || !Number.isInteger(detail.revision)) throw error;
    if (!isCurrent() || !await confirm(
      `This edit clears saved targets for ${detail.lost_target_count} atoms in affected coordinate groups, `
      + "including group members outside the selection. New targets will be taken from the structure "
      + "when model inputs are prepared. Undo restores the saved targets.", "Discard and apply",
    ) || !isCurrent()) return null;
    return api<T>(path, {
      ...request,
      body: JSON.stringify({
        ...(body as Record<string, unknown>),
        allow_target_discard: true,
        expected_revision: detail.revision,
      }),
    });
  }
}
