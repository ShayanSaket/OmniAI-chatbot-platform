// The widget runs inside an iframe on customers' websites: transparent background, its
// own light color scheme (must match the iframe element's, or browsers paint it opaque),
// and none of the dashboard providers.
export default function WidgetLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`html,body{background:transparent!important;color-scheme:light;overflow:hidden}`}</style>
      {children}
    </>
  );
}
