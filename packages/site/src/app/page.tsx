import Link from "next/link";
import { Features } from "@/components/Features";
import { Hero } from "@/components/Hero";

export default function Home() {
  return (
    <>
      <Hero />
      <Features />

      <section className="closing-section section-rule">
        <div className="site-shell closing-grid">
          <div>
            <div className="section-kicker">Get started</div>
            <h2>Make the first agent yours.</h2>
          </div>
          <div className="closing-copy">
            <p>
              Install the CLI, run the setup wizard, and point TAI at a local or hosted model. The quick start gets from
              an empty directory to an agent that can use real tools.
            </p>
            <div className="closing-actions">
              <Link href="/docs/quick-start" className="button button-primary">
                Follow the quick start
              </Link>
              <Link href="/docs" className="button button-secondary">
                Read the docs
              </Link>
            </div>
            <p className="status-note">
              TAI is pre-1.0 and under active development. It works end to end today; APIs may change as the project
              matures.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
