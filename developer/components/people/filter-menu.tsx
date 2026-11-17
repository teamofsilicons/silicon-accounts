"use client";

import { useRef, type ReactNode } from "react";
import { returnFocusTo } from "@/components/silicon-ui/lib/return-focus";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/silicon-ui/button/button";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/silicon-ui/popover/popover";
import styles from "./filter-menu.module.css";

export function FilterMenu({ count, clear, children }: { count: number; clear: () => void; children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Popover>
      <PopoverTrigger asChild ref={trigger}>
        <Button type="button" variant={count ? "secondary" : "ghost"} aria-label={count ? `Filters, ${count} active` : "Filters"}>
          <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden="true"/>
          Filters{count > 0 && <span className={styles.count}>{count}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent onCloseAutoFocus={event => returnFocusTo(trigger.current)(event)} align="end" aria-label="Filters" className={styles.panel}>
        {children}
        <div className={styles.actions}>
          <Button type="button" variant="ghost" size="sm" aria-disabled={!count} onClick={count ? clear : undefined}>Clear filters</Button>
          <PopoverClose asChild><Button type="button" variant="secondary" size="sm">Done</Button></PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  );
}
