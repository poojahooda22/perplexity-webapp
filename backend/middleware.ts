import type { Request, Response, NextFunction } from "express";
import { createSupabaseClient } from "./client";
import { prisma } from "./db";

const client = createSupabaseClient();

export interface AuthenticatedRequest extends Request {
    userId?: string;
}

export async function middleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const token = req.headers.authorization;

    const data = await client.auth.getUser(token);
    const userId = data.data.user?.id

    if(userId) {
        try {
            await prisma.user.upsert({
                where: { email: data.data.user?.email! },
                update: {},
                create: {
                    id: data.data.user!.id,
                    email: data.data.user?.email!,
                    provider: data.data.user?.app_metadata.provider === "google" ? "Google" : "Github",
                    name: data.data.user?.user_metadata.full_name,
                    supabaseId: data.data.user!.id
                }
            })
        } catch (e) {
            console.log(e)
        }
        req.userId = userId;
        next();
    } else {
        return res.status(401).json({ error: "unauthorised"});
    }
}
