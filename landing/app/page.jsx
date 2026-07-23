import Image from 'next/image';
import Nav from '@/components/Nav';
import Hero from '@/components/Hero';
import Chapter from '@/components/Chapter';
import InstallSection from '@/components/InstallSection';
import DownloadSection from '@/components/DownloadSection';
import ContactSection from '@/components/ContactSection';
import Footer from '@/components/Footer';
import Interlude from '@/components/Interlude';
import SideNav from '@/components/SideNav';
import { CHAPTERS } from '@/lib/chapters';

export default function Page() {
  let orderOffset = 0;
  return (
    <main>
      <Nav />
      <SideNav />
      <Hero />
      <InstallSection />
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
      <ContactSection />
      <Footer />
    </main>
  );
}
