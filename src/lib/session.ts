import { cache } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

/** Một lần / request — tránh getServerSession lặp ở layout + page. */
export const getSession = cache(() => getServerSession(authOptions));
