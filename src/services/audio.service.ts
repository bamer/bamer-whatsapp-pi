import { downloadContentFromMessage } from 'baileys';
import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { t } from '../i18n.js';
import { WhatsAppPiLogger } from './whatsapp-pi.logger.js';

const execAsync = promisify(exec);

export class AudioService {
  private readonly mediaDir = join(homedir(), '.pi', 'whatsapp-medias');
  private readonly transcribeScript = join(homedir(), '.pi', 'agent', 'voice-transcription', 'transcribe.sh');
  private readonly useSherpaOnnx = existsSync(join(homedir(), '.pi', 'agent', 'voice-transcription', 'transcribe.sh'));

  constructor(private logger?: WhatsAppPiLogger) {
    if (!existsSync(this.mediaDir)) {
      mkdir(this.mediaDir, { recursive: true }).catch(() => {});
    }
  }

  async transcribe(audioMessage: any): Promise<string> {
    try {
      const filename = `audio_${Date.now()}`;
      const inputPath = join(this.mediaDir, `${filename}.ogg`);

      // Download audio content
      const stream = await downloadContentFromMessage(audioMessage, 'audio');
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }
      await writeFile(inputPath, buffer);

      // Transcribe using sherpa-onnx (preferred) or Whisper (fallback)
      let command: string;
      if (this.useSherpaOnnx) {
        // Use the existing sherpa-onnx transcription script
        command = `${this.transcribeScript} "${inputPath}"`;
      } else {
        // Fallback to whisper (legacy)
        const whisperPath = process.platform === 'win32' ? 'python -m whisper' : join(homedir(), '.local', 'bin', 'whisper');
        command = `${whisperPath} "${inputPath}" --model small --language pt --output_format txt --output_dir "${this.mediaDir}" --fp16 False`;
      }

      // CAPTURER LA SORTIE DU SCRIPT (stdout)
      const { stdout, stderr } = await execAsync(command);
      
      // Si le script a retourné un texte via stdout, l'utiliser
      const text = stdout ? stdout.trim() : '';
      if (text) {
        return text;
      }
      
      // Fallback: chercher un fichier .txt (ancien comportement)
      const txtPath = join(this.mediaDir, `${filename}.txt`);
      if (existsSync(txtPath)) {
        const fs = await import('node:fs/promises');
        const fileText = await fs.readFile(txtPath, 'utf8');
        return fileText.trim();
      }
      
      // Si rien, retourner vide
      return t('audio.emptyTranscription');
    } catch (error) {
      this.logger?.error(t('audio.transcriptionError'), error);
      return t('audio.transcriptionErrorResult', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
