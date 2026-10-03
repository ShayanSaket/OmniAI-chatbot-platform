import 'server-only';
import { env } from '../env';
import { ProviderError, ProviderNotConfiguredError } from './provider';

// Speech-to-text for voice messages (OpenAI-compatible /audio/transcriptions).

const TIMEOUT_MS = 60_000;
/** The transcription API accepts files up to 25 MB. */
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

export async function transcribeAudio(bytes: Uint8Array, mimeType: string, fileName: string): Promise<{ text: string; model: string }> {
  const e = env();
  if (!e.OPENAI_API_KEY) throw new ProviderNotConfiguredError();
  if (bytes.byteLength > MAX_TRANSCRIPTION_BYTES) throw new ProviderError('Audio file too large to transcribe');
  const form = new FormData();
  form.set('model', e.OPENAI_TRANSCRIPTION_MODEL);
  form.set('response_format', 'json');
  form.set('file', new Blob([bytes], { type: mimeType }), fileName);
  let res: Response;
  try {
    res = await fetch(`${e.OPENAI_BASE_URL.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${e.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProviderError(`Transcription request failed: ${(err as Error).message}`, undefined, true);
  }
  if (!res.ok) throw new ProviderError(`Transcription failed with ${res.status}`, res.status, res.status >= 500 || res.status === 429);
  const data = (await res.json()) as { text?: string };
  return { text: (data.text ?? '').trim(), model: e.OPENAI_TRANSCRIPTION_MODEL };
}
