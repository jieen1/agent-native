import { useState, type ReactNode } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useCreateProject } from "@/hooks/use-tracker";
import { toast } from "sonner";

export function NewProjectDialog({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [gitRemote, setGitRemote] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [description, setDescription] = useState("");
  const create = useCreateProject();
  const navigate = useNavigate();

  function reset() {
    setName("");
    setGitRemote("");
    setDefaultBranch("main");
    setDescription("");
  }

  function submit() {
    if (!name.trim()) {
      toast.error("Project name is required");
      return;
    }
    create.mutate(
      {
        name: name.trim(),
        gitRemote: gitRemote.trim(),
        defaultBranch: defaultBranch.trim() || "main",
        description: description.trim(),
      },
      {
        onSuccess: (p: { id: string }) => {
          toast.success("Project created");
          setOpen(false);
          reset();
          navigate(`/board?project=${encodeURIComponent(p.id)}`);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Configure the repo and default branch once. Every work item under this
            project inherits that context when dispatched.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My App"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-remote">Git remote</Label>
            <Input
              id="project-remote"
              value={gitRemote}
              onChange={(e) => setGitRemote(e.target.value)}
              placeholder="https://github.com/org/repo.git"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-branch">Default branch</Label>
            <Input
              id="project-branch"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              placeholder="main"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-desc">Description (optional)</Label>
            <Textarea
              id="project-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
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
            {create.isPending ? "Creating..." : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
