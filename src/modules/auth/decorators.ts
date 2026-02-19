import { SetMetadata } from "@nestjs/common";
import { UserRole } from "../../common/schemas/user.schema";

export const Roles = (...roles: UserRole[]) => SetMetadata("roles", roles);
export const RequireTenant = () => SetMetadata("tenant", true);
