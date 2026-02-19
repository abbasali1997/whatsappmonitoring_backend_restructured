import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly algorithm = "aes-256-gcm";
  private readonly keyLength = 32;
  private readonly ivLength = 16;
  private readonly tagLength = 16;

  constructor(private configService: ConfigService) {}

  encrypt(text: string, key?: string): string {
    try {
      const encryptionKey =
        key ||
        this.configService.get<string>("encryption.key") ||
        "default-key";
      const derivedKey = crypto.scryptSync(
        encryptionKey,
        "salt",
        this.keyLength,
      );
      const iv = crypto.randomBytes(this.ivLength);
      const cipher = crypto.createCipher(this.algorithm, derivedKey);

      let encrypted = cipher.update(text, "utf8", "hex");
      encrypted += cipher.final("hex");

      return iv.toString("hex") + ":" + encrypted;
    } catch (error) {
      this.logger.error("Encryption failed:", error);
      throw new Error("Encryption failed");
    }
  }

  decrypt(encryptedText: string, key?: string): string {
    try {
      const encryptionKey =
        key ||
        this.configService.get<string>("encryption.key") ||
        "default-key";
      const derivedKey = crypto.scryptSync(
        encryptionKey,
        "salt",
        this.keyLength,
      );
      const [, encrypted] = encryptedText.split(":");
      const decipher = crypto.createDecipher(this.algorithm, derivedKey);

      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");

      return decrypted;
    } catch (error) {
      this.logger.error("Decryption failed:", error);
      throw new Error("Decryption failed");
    }
  }

  hash(text: string, salt?: string): string {
    const saltToUse = salt || crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(text, saltToUse, 10000, 64, "sha512");
    return saltToUse + ":" + hash.toString("hex");
  }

  verifyHash(text: string, hash: string): boolean {
    try {
      const [salt, hashValue] = hash.split(":");
      const testHash = crypto.pbkdf2Sync(text, salt, 10000, 64, "sha512");
      return crypto.timingSafeEqual(Buffer.from(hashValue, "hex"), testHash);
    } catch (error) {
      this.logger.error("Hash verification failed:", error);
      return false;
    }
  }

  generateRandomString(length: number = 32): string {
    return crypto.randomBytes(length).toString("hex");
  }

  generateUUID(): string {
    return crypto.randomUUID();
  }

  generateSecureToken(): string {
    return crypto.randomBytes(32).toString("base64url");
  }
}
