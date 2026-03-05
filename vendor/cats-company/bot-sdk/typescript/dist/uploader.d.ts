import type { UploadResult } from './types';
export declare class FileUploader {
    private readonly httpBaseUrl;
    private readonly apiKey;
    constructor(httpBaseUrl: string, apiKey: string);
    /**
     * Upload a file from disk.
     */
    upload(filePath: string, type?: 'image' | 'file'): Promise<UploadResult>;
    /**
     * Upload a buffer with a given filename.
     */
    uploadBuffer(buffer: Buffer, filename: string, type?: 'image' | 'file'): Promise<UploadResult>;
    private resolveContentType;
}
//# sourceMappingURL=uploader.d.ts.map