import { downloadContentFromMessage } from 'baileys';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LiteParse } from '@llamaindex/liteparse';
import { AudioService } from './audio.service.js';
import type { IncomingResolution } from './incoming-message.resolver.js';
import { WhatsAppPiLogger } from './whatsapp-pi.logger.js';
import { createStoragePaths } from './storage-path.js';
import { t } from '../i18n.js';

export interface ProcessedIncomingContent {
    text: string;
    imageBuffer?: Buffer;
    imageMimeType?: string;
    savedMediaPath?: string;  // Path where media was saved
}

const PDF_PREVIEW_LIMIT = 1200;

export class IncomingMediaService {
    private readonly pdfParser = new LiteParse({ ocrEnabled: true });

    constructor(
        private readonly audioService: AudioService,
        private readonly logger = new WhatsAppPiLogger(false)
    ) {}

    async process(resolved: IncomingResolution, pushName: string): Promise<ProcessedIncomingContent> {
        if (resolved.kind === 'audio') {
            return this.processAudio(resolved.audioMessage, pushName);
        }

        if (resolved.kind === 'image') {
            return this.processImage(resolved.imageMessage, resolved.text, pushName);
        }

        if (resolved.kind === 'video') {
            return this.processVideo(resolved.videoMessage, resolved.text, pushName);
        }

        if (resolved.kind === 'document') {
            return this.processDocument(resolved.documentMessage, pushName);
        }

        return { text: resolved.text };
    }

    private async processAudio(audioMessage: any, pushName: string): Promise<ProcessedIncomingContent> {
        this.logger.log(t('incoming.media.audioTranscribing', { pushName }));
        const transcription = await this.audioService.transcribe(audioMessage);
        return { text: t('incoming.media.audioTranscribed', { transcription }) };
    }

    private async processImage(imageMessage: any, fallbackText: string, pushName: string): Promise<ProcessedIncomingContent> {
        this.logger.log(t('incoming.media.imageDownloading', { pushName }));

        try {
            const imageBuffer = await this.downloadMessage(imageMessage, 'image');
            const rawMime = imageMessage.mimetype || 'image/jpeg';
            let imageMimeType = rawMime.toLowerCase().split(';')[0].trim();
            if (imageMimeType === 'image/jpg') imageMimeType = 'image/jpeg';

            // Save to whatsapp-medias directory
            const ext = imageMimeType.includes('png') ? '.png' : '.jpg';
            const savedPath = await this.saveMediaToDisk(imageBuffer, `image_${Date.now()}${ext}`, 'image');

            this.logger.log(t('incoming.media.imageDownloaded', { imageMimeType, rawMime, size: imageBuffer.length }));

            return {
                text: fallbackText || t('incoming.media.image'),
                imageBuffer,
                imageMimeType,
                savedMediaPath: savedPath
            };
        } catch (error) {
            this.logger.error(t('incoming.media.imageDownloadFailed'), error);
            return { text: t('incoming.media.imageDownloadFailedText') };
        }
    }

    private async processVideo(videoMessage: any, fallbackText: string, pushName: string): Promise<ProcessedIncomingContent> {
        this.logger.log(`[WhatsApp-Pi] Downloading video from ${pushName}...`);

        try {
            const videoBuffer = await this.downloadMessage(videoMessage, 'video');
            const rawMime = videoMessage.mimetype || 'video/mp4';
            const mimeType = rawMime.toLowerCase().split(';')[0].trim();

            // Save to whatsapp-medias directory
            const ext = mimeType.includes('webm') ? '.webm' : '.mp4';
            const savedPath = await this.saveMediaToDisk(videoBuffer, `video_${Date.now()}${ext}`, 'video');

            this.logger.log(`[WhatsApp-Pi] Video saved: ${savedPath} (${videoBuffer.length} bytes)`);

            return {
                text: fallbackText || `[Video received: ${savedPath}]`,
                savedMediaPath: savedPath
            };
        } catch (error) {
            this.logger.error(`[WhatsApp-Pi] Video download failed`, error);
            return { text: '[Video download failed]' };
        }
    }

    private async processDocument(documentMessage: any, pushName: string): Promise<ProcessedIncomingContent> {
        const fileName = documentMessage.fileName || 'unnamed_document';
        const mimeType = documentMessage.mimetype || 'application/octet-stream';
        const fileSize = documentMessage.fileLength ? Number(documentMessage.fileLength) : 0;

        this.logger.log(t('incoming.media.documentDownloading', { pushName, fileName }));

        try {
            const buffer = await this.downloadMessage(documentMessage, 'document');
            const relativePath = await this.saveDocument(fileName, buffer);

            this.logger.log(t('incoming.media.documentSaved', { relativePath, size: buffer.length }));

            let text = t('incoming.media.documentReceived', { fileName }) + '\n'
                + t('incoming.media.documentMimeType', { mimeType }) + '\n'
                + t('incoming.media.documentSize', { size: this.formatFileSize(fileSize) }) + '\n'
                + t('incoming.media.documentLocation', { relativePath });

            if (this.isPdfDocument(fileName, mimeType)) {
                const preview = await this.extractPdfPreview(buffer);
                if (preview) {
                    text += `\n\n${t('incoming.media.documentPdfPreviewHeading')}\n${preview}`;
                } else {
                    text += `\n\n${t('incoming.media.documentPdfFallbackNotice')}`;
                }
            }

            if (documentMessage.caption) {
                text += `\n\n${t('incoming.media.documentDescription', { caption: documentMessage.caption })}`;
            }

            return { text };
        } catch (error) {
            this.logger.error(t('incoming.media.documentDownloadFailed'), error);
            return { text: t('incoming.media.documentDownloadFailedText', { fileName }) };
        }
    }

    private async extractPdfPreview(buffer: Buffer): Promise<string | null> {
        try {
            const result = await this.pdfParser.parse(buffer);
            return this.formatPdfPreview(result.text);
        } catch (error) {
            this.logger.warn('[WhatsApp-Pi] PDF parsing failed, falling back to storage-only behavior.', error);
            return null;
        }
    }

    private formatPdfPreview(text: string | undefined | null): string | null {
        const normalized = (text || '').replace(/\r\n/g, '\n').trim();
        if (!normalized) {
            return null;
        }

        if (normalized.length <= PDF_PREVIEW_LIMIT) {
            return normalized;
        }

        return `${normalized.slice(0, PDF_PREVIEW_LIMIT)}…`;
    }

    private isPdfDocument(fileName: string, mimeType: string): boolean {
        const normalizedMimeType = mimeType.toLowerCase().split(';')[0].trim();
        return normalizedMimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
    }

    private async downloadMessage(message: any, type: 'image' | 'video' | 'document'): Promise<Buffer> {
        const stream = await downloadContentFromMessage(message, type);
        let buffer = Buffer.from([]);

        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        return buffer;
    }

    private async saveMediaToDisk(buffer: Buffer, fileName: string, type: 'image' | 'video'): Promise<string> {
        const { mediaDir } = createStoragePaths();
        const subDir = join(mediaDir, type);
        await mkdir(subDir, { recursive: true });
        const filePath = join(subDir, fileName);
        await writeFile(filePath, buffer);
        return filePath;
    }

    private async saveDocument(fileName: string, buffer: Buffer): Promise<string> {
        const sanitized = fileName.replace(/[^a-z0-9._-]/gi, '_');
        const savedFileName = `${Date.now()}_${sanitized}`;
        const { mediaDir } = createStoragePaths();
        const documentDir = join(mediaDir, 'documents');
        await mkdir(documentDir, { recursive: true });
        const filePath = join(documentDir, savedFileName);
        await writeFile(filePath, buffer);
        return filePath;
    }

    private formatFileSize(fileSize: number): string {
        if (fileSize > 1024 * 1024) {
            return `${(fileSize / (1024 * 1024)).toFixed(1)} MB`;
        }

        return `${(fileSize / 1024).toFixed(1)} KB`;
    }
}
