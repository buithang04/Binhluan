import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function getSessionUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;
  return session.user;
}

export async function getOwnedProject(projectId: string, userId: string, isAdmin: boolean) {
  return prisma.project.findFirst({
    where: isAdmin ? { id: projectId } : { id: projectId, userId },
    include: {
      package: true,
      products: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });
}

export async function getOwnedCampaign(
  campaignId: string,
  userId: string,
  isAdmin: boolean,
) {
  return prisma.contentCampaign.findFirst({
    where: isAdmin
      ? { id: campaignId }
      : { id: campaignId, project: { userId } },
    include: {
      project: { include: { package: true, products: true, user: true } },
      template: true,
      contents: { orderBy: { variantIndex: "asc" } },
    },
  });
}
