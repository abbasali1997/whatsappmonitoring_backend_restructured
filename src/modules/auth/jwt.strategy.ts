import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, ExtractJwt } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { AuthService, JwtPayload } from "./auth.service";
import { User } from "../../common/schemas/user.schema";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private authService: AuthService,
    private configService: ConfigService,
    @InjectModel(User.name) private userModel: Model<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>("jwt.secret"),
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    if (!payload?.sub) {
      return payload;
    }

    try {
      const user = await this.userModel
        .findById(payload.sub)
        .select("entityId entityIdPath entityPath tenantId role email")
        .lean();

      if (!user) {
        return payload;
      }

      const entityIdPath = Array.isArray(user.entityIdPath)
        ? user.entityIdPath.map((id) => id.toString())
        : undefined;

      return {
        ...payload,
        tenantId: payload.tenantId || user.tenantId?.toString(),
        entityId: payload.entityId || user.entityId?.toString(),
        entityPath: user.entityPath,
        entityIdPath,
      } as JwtPayload;
    } catch {
      return payload;
    }
  }
}
