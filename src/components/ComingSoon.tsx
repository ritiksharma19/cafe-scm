export function ComingSoon({ title, phase, children }: { title: string; phase: number; children?: React.ReactNode }) {
  return (
    <section className="card flex flex-col gap-2 p-5">
      <h1 className="text-xl font-bold">{title}</h1>
      <p className="text-muted">
        Arrives in Phase {phase}.{children ? " " : ""}
        {children}
      </p>
    </section>
  );
}
