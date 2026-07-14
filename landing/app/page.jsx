import Image from 'next/image';
import Nav from '@/components/Nav';
import Hero from '@/components/Hero';
import CoreFour from '@/components/CoreFour';
import Chapter from '@/components/Chapter';
import DownloadSection from '@/components/DownloadSection';
import PricingSection from '@/components/PricingSection';
import Footer from '@/components/Footer';
import Interlude from '@/components/Interlude';
import { CHAPTERS } from '@/lib/chapters';

export default function Page() {
  let orderOffset = 0;
  return (
    <main>
      <Nav />
      <Hero />
      <CoreFour />
      {CHAPTERS.map((chapter, i) => {
        const offset = orderOffset;
        orderOffset += chapter.features.length;
        return (
          <div key={chapter.id}>
            <Chapter chapter={chapter} orderOffset={offset} />
            {i === 1 && (
              <Interlude>
                <Image
                  src="/assets/art/interlude-constellation.webp"
                  alt=""
                  width={1536}
                  height={1024}
                  sizes="100vw"
                  style={{ width: '100%', height: 'auto' }}
                />
              </Interlude>
            )}
          </div>
        );
      })}
      <DownloadSection />
      <PricingSection />
      <Footer />
    </main>
  );
}
