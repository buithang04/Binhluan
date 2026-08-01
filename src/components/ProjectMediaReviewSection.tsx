"use client";

import { useCallback, useState } from "react";
import { ProjectMediaPanel, type MediaItem } from "@/components/ProjectMediaPanel";
import { ReviewPlanPanel } from "@/components/ReviewPlanPanel";
import type { ComponentProps } from "react";

type ReviewPlanPanelProps = ComponentProps<typeof ReviewPlanPanel>;

export function ProjectMediaReviewSection({
  projectId,
  initialMedia,
  reviewPlan,
}: {
  projectId: string;
  initialMedia: MediaItem[];
  reviewPlan: Omit<ReviewPlanPanelProps, "projectId" | "initialMediaCount">;
}) {
  const [mediaCount, setMediaCount] = useState(initialMedia.length);
  const handleMediaChange = useCallback((items: MediaItem[]) => {
    setMediaCount(items.length);
  }, []);

  return (
    <>
      <div id="project-media" className="scroll-mt-6">
        <ProjectMediaPanel
          projectId={projectId}
          initialMedia={initialMedia}
          onMediaChange={handleMediaChange}
        />
      </div>

      <ReviewPlanPanel
        key={projectId}
        projectId={projectId}
        initialMediaCount={mediaCount}
        {...reviewPlan}
      />
    </>
  );
}
