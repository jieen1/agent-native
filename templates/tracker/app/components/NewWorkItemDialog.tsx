import { useState, useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useCreateWorkItem, useProjects } from "@/hooks/use-tracker";
import { toast } from "sonner";

const TYPES = ["requirement", "task", "defect", "incident"] as const;

export function NewWorkItemDialog({
  children,
  defaultProjectId,
}: {
  children: ReactNode;
  defaultProjectId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<string>("requirement");
  const [description, setDescription] = useState("");
  const create = useCreateWorkItem();
  const navigate = useNavigate();
  const { data: projectsData } = useProjects();
  const projects = Array.isArray(projectsData) ? projectsData : [];

  useEffect(() => {
    if (open) {
      setProjectId(defaultProjectId ?? (projects[0]?.id ?? ""));
    }
  }, [open, defaultProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  function submit() {
    if (!projectId) {
      toast.error("Pick a project");
      return;
    }
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    create.mutate(
      {
        projectId,
        title: title.trim(),
        type: type as (typeof TYPES)[number],
        description: description.trim(),
      },
      {
        onSuccess: (it: { id: string }) => {
          toast.success("Work item created");
          setOpen(false);
          setTitle("");
          setDescription("");
          setType("requirement");
          navigate(`/items/${it.id}`);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New work item</DialogTitle>
          <DialogDescription>
            Describe the requirement. The repo and branch come from the project —
            work items never carry a repo.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Project</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.key} · {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="item-title">Title</Label>
            <Input
              id="item-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add a health-check endpoint"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="item-req">Requirement</Label>
            <Textarea
              id="item-req"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              placeholder="Describe what the orchestrator brain should build. No repo needed — it comes from the project."
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? "Creating..." : "Create work item"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
