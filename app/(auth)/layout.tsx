export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-[#0A0D14] px-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-center font-display text-xl font-semibold tracking-tight text-[#E6E9EF]">
          AdStudio
        </h1>
        {children}
      </div>
    </div>
  );
}
