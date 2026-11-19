import { AppError } from "./errors";

/** What a server action hands back to its form (useActionState). */
export type FormState = { error?: string; fieldErrors?: Record<string, string[]>; ok?: boolean; message?: string };

/**
 * Turn an error thrown inside a server action into form state. An AppError is meant for the person (its message and
 * field errors are shown); anything else is logged under `action` and replaced by a generic message, so internals never
 * reach the page.
 */
export function actionErrorState(err: unknown, action: string): FormState {
  if (err instanceof AppError) return { error: err.message, fieldErrors: err.fieldErrors };
  console.error(JSON.stringify({ level: "error", action, message: (err as Error).message }));
  return { error: "Something went wrong. Please try again." };
}
