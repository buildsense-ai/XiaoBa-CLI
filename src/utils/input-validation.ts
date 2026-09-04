/**
 * Input Validation Utilities for Tool Arguments
 * 
 * This module provides validation functions to ensure tool arguments
 * meet expected formats and constraints before execution.
 */

import * as path from 'path';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Maximum allowed path length across platforms.
 * Windows has a MAX_PATH of 260, but extended paths can go up to ~32,767.
 * We use a conservative limit for safety.
 */
const MAX_PATH_LENGTH = 4096;

/**
 * Maximum allowed command length for shell execution.
 */
const MAX_COMMAND_LENGTH = 10000;

/**
 * Maximum allowed file content size (10 MB).
 */
const MAX_FILE_CONTENT_SIZE = 10 * 1024 * 1024;

/**
 * Dangerous path patterns that should never be allowed.
 */
const DANGEROUS_PATH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\/sys\//i, reason: 'System paths under /sys are protected' },
  { pattern: /^\/proc\//i, reason: 'System paths under /proc are protected' },
  { pattern: /\.\.\//i, reason: 'Path traversal detected' },
  { pattern: /[\x00-\x1f]/, reason: 'Control characters are not allowed in paths' },
];

/**
 * Validate a file path argument.
 */
export function validateFilePath(filePath: unknown, fieldName: string = 'file_path'): ValidationResult {
  if (filePath === undefined || filePath === null) {
    return { valid: false, error: `${fieldName} is required` };
  }
  
  if (typeof filePath !== 'string') {
    return { valid: false, error: `${fieldName} must be a string` };
  }
  
  const trimmedPath = filePath.trim();
  
  if (trimmedPath.length === 0) {
    return { valid: false, error: `${fieldName} cannot be empty` };
  }
  
  if (trimmedPath.length > MAX_PATH_LENGTH) {
    return { valid: false, error: `${fieldName} exceeds maximum length of ${MAX_PATH_LENGTH} characters` };
  }
  
  // Check for dangerous patterns
  for (const rule of DANGEROUS_PATH_PATTERNS) {
    if (rule.pattern.test(trimmedPath)) {
      return { valid: false, error: `${fieldName}: ${rule.reason}` };
    }
  }
  
  // Check for null bytes
  if (filePath.includes('\0')) {
    return { valid: false, error: `${fieldName} contains null bytes` };
  }
  
  return { valid: true };
}

/**
 * Validate a shell command argument.
 */
export function validateCommand(command: unknown, fieldName: string = 'command'): ValidationResult {
  if (command === undefined || command === null) {
    return { valid: false, error: `${fieldName} is required` };
  }
  
  if (typeof command !== 'string') {
    return { valid: false, error: `${fieldName} must be a string` };
  }
  
  const trimmedCommand = command.trim();
  
  if (trimmedCommand.length === 0) {
    return { valid: false, error: `${fieldName} cannot be empty` };
  }
  
  if (trimmedCommand.length > MAX_COMMAND_LENGTH) {
    return { valid: false, error: `${fieldName} exceeds maximum length of ${MAX_COMMAND_LENGTH} characters` };
  }
  
  // Check for null bytes
  if (command.includes('\0')) {
    return { valid: false, error: `${fieldName} contains null bytes` };
  }
  
  return { valid: true };
}

/**
 * Validate file content argument.
 */
export function validateFileContent(content: unknown, fieldName: string = 'content'): ValidationResult {
  if (content === undefined || content === null) {
    return { valid: false, error: `${fieldName} is required` };
  }
  
  if (typeof content !== 'string') {
    return { valid: false, error: `${fieldName} must be a string` };
  }
  
  const contentBytes = Buffer.byteLength(content, 'utf-8');
  
  if (contentBytes > MAX_FILE_CONTENT_SIZE) {
    return { 
      valid: false, 
      error: `${fieldName} exceeds maximum size of ${MAX_FILE_CONTENT_SIZE} bytes` 
    };
  }
  
  // Check for null bytes (not valid in UTF-8)
  if (content.includes('\0')) {
    return { valid: false, error: `${fieldName} contains null bytes` };
  }
  
  return { valid: true };
}

/**
 * Validate timeout argument.
 */
export function validateTimeout(timeout: unknown, fieldName: string = 'timeout'): ValidationResult {
  if (timeout === undefined || timeout === null) {
    return { valid: true }; // Optional field
  }
  
  if (typeof timeout !== 'number') {
    return { valid: false, error: `${fieldName} must be a number` };
  }
  
  if (!Number.isFinite(timeout)) {
    return { valid: false, error: `${fieldName} must be a finite number` };
  }
  
  if (timeout < 0) {
    return { valid: false, error: `${fieldName} cannot be negative` };
  }
  
  // Reasonable upper limit of 1 hour
  if (timeout > 3600000) {
    return { valid: false, error: `${fieldName} exceeds maximum allowed value of 3600000ms (1 hour)` };
  }
  
  return { valid: true };
}

/**
 * Validate a generic string argument.
 */
export function validateString(value: unknown, fieldName: string, maxLength: number = 10000): ValidationResult {
  if (value === undefined || value === null) {
    return { valid: true }; // Optional field
  }
  
  if (typeof value !== 'string') {
    return { valid: false, error: `${fieldName} must be a string` };
  }
  
  if (value.length > maxLength) {
    return { valid: false, error: `${fieldName} exceeds maximum length of ${maxLength} characters` };
  }
  
  // Check for null bytes
  if (value.includes('\0')) {
    return { valid: false, error: `${fieldName} contains null bytes` };
  }
  
  return { valid: true };
}

/**
 * Validate a boolean argument.
 */
export function validateBoolean(value: unknown, fieldName: string): ValidationResult {
  if (value === undefined || value === null) {
    return { valid: true }; // Optional field
  }
  
  if (typeof value !== 'boolean') {
    return { valid: false, error: `${fieldName} must be a boolean` };
  }
  
  return { valid: true };
}

/**
 * Validate an integer argument.
 */
export function validateInteger(value: unknown, fieldName: string, min?: number, max?: number): ValidationResult {
  if (value === undefined || value === null) {
    return { valid: true }; // Optional field
  }
  
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { valid: false, error: `${fieldName} must be an integer` };
  }
  
  if (min !== undefined && value < min) {
    return { valid: false, error: `${fieldName} must be at least ${min}` };
  }
  
  if (max !== undefined && value > max) {
    return { valid: false, error: `${fieldName} must be at most ${max}` };
  }
  
  return { valid: true };
}

/**
 * Combined validator for shell tool arguments.
 */
export function validateShellToolArgs(args: any): ValidationResult {
  if (!args || typeof args !== 'object') {
    return { valid: false, error: 'Arguments must be an object' };
  }
  
  const commandValidation = validateCommand(args.command);
  if (!commandValidation.valid) return commandValidation;
  
  const timeoutValidation = validateTimeout(args.timeout);
  if (!timeoutValidation.valid) return timeoutValidation;
  
  if (args.cwd !== undefined) {
    const cwdValidation = validateFilePath(args.cwd, 'cwd');
    if (!cwdValidation.valid) return cwdValidation;
  }
  
  if (args.confirm_dangerous !== undefined) {
    const confirmValidation = validateBoolean(args.confirm_dangerous, 'confirm_dangerous');
    if (!confirmValidation.valid) return confirmValidation;
  }
  
  return { valid: true };
}

/**
 * Combined validator for write tool arguments.
 */
export function validateWriteToolArgs(args: any): ValidationResult {
  if (!args || typeof args !== 'object') {
    return { valid: false, error: 'Arguments must be an object' };
  }
  
  const pathValidation = validateFilePath(args.file_path, 'file_path');
  if (!pathValidation.valid) return pathValidation;
  
  const contentValidation = validateFileContent(args.content, 'content');
  if (!contentValidation.valid) return contentValidation;
  
  return { valid: true };
}

/**
 * Combined validator for read tool arguments.
 */
export function validateReadToolArgs(args: any): ValidationResult {
  if (!args || typeof args !== 'object') {
    return { valid: false, error: 'Arguments must be an object' };
  }
  
  const pathValidation = validateFilePath(args.file_path, 'file_path');
  if (!pathValidation.valid) return pathValidation;
  
  if (args.offset !== undefined) {
    const offsetValidation = validateInteger(args.offset, 'offset', 0);
    if (!offsetValidation.valid) return offsetValidation;
  }
  
  if (args.limit !== undefined) {
    const limitValidation = validateInteger(args.limit, 'limit', 0, 100000);
    if (!limitValidation.valid) return limitValidation;
  }
  
  return { valid: true };
}
