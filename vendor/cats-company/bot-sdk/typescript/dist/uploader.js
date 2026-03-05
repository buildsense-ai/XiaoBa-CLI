"use strict";
// FileUploader — HTTP multipart upload to Cats Company server.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileUploader = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const errors_1 = require("./errors");
const IMAGE_MIME_TYPES = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
};
class FileUploader {
    httpBaseUrl;
    apiKey;
    constructor(httpBaseUrl, apiKey) {
        this.httpBaseUrl = httpBaseUrl.replace(/\/$/, '');
        this.apiKey = apiKey;
    }
    /**
     * Upload a file from disk.
     */
    async upload(filePath, type = 'file') {
        const buffer = fs.readFileSync(filePath);
        const filename = path.basename(filePath);
        return this.uploadBuffer(buffer, filename, type);
    }
    /**
     * Upload a buffer with a given filename.
     */
    async uploadBuffer(buffer, filename, type = 'file') {
        const url = `${this.httpBaseUrl}/api/upload?type=${type}`;
        const contentType = this.resolveContentType(filename, type);
        // Build multipart/form-data body manually for maximum compatibility
        const boundary = `----CatsBotBoundary${crypto.randomBytes(16).toString('hex')}`;
        const header = Buffer.from(`--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
            `Content-Type: ${contentType}\r\n\r\n`);
        const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([header, buffer, footer]);
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `ApiKey ${this.apiKey}`,
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                },
                body,
            });
        }
        catch (err) {
            throw new errors_1.UploadError(`Upload request failed: ${err.message}`);
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new errors_1.UploadError(`Upload failed (${res.status}): ${text}`, res.status);
        }
        return (await res.json());
    }
    resolveContentType(filename, type) {
        if (type !== 'image') {
            return 'application/octet-stream';
        }
        const ext = path.extname(filename).toLowerCase();
        return IMAGE_MIME_TYPES[ext] ?? 'application/octet-stream';
    }
}
exports.FileUploader = FileUploader;
//# sourceMappingURL=uploader.js.map