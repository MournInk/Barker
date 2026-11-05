"use client";

import { Icon } from "@iconify/react";
import bell from "@iconify-icons/gravity-ui/bell";
import squares from "@iconify-icons/gravity-ui/layout-cells-large";
import calendar from "@iconify-icons/gravity-ui/calendar";
import clock from "@iconify-icons/gravity-ui/clock";
import gear from "@iconify-icons/gravity-ui/gear";
import plus from "@iconify-icons/gravity-ui/plus";
import arrow from "@iconify-icons/gravity-ui/arrow-right";
import chevron from "@iconify-icons/gravity-ui/chevron-right";
import check from "@iconify-icons/gravity-ui/check";
import circleCheck from "@iconify-icons/gravity-ui/circle-check";
import shield from "@iconify-icons/gravity-ui/shield-check";
import refresh from "@iconify-icons/gravity-ui/arrows-rotate-right";
import search from "@iconify-icons/gravity-ui/magnifier";
import send from "@iconify-icons/gravity-ui/paper-plane";
import pause from "@iconify-icons/gravity-ui/pause";
import play from "@iconify-icons/gravity-ui/play";
import edit from "@iconify-icons/gravity-ui/pencil";
import copy from "@iconify-icons/gravity-ui/copy";
import archive from "@iconify-icons/gravity-ui/archive";
import close from "@iconify-icons/gravity-ui/xmark";
import menu from "@iconify-icons/gravity-ui/bars";
import logout from "@iconify-icons/gravity-ui/arrow-right-from-square";
import warning from "@iconify-icons/gravity-ui/triangle-exclamation";
import lock from "@iconify-icons/gravity-ui/lock";
import link from "@iconify-icons/gravity-ui/link";
import globe from "@iconify-icons/gravity-ui/globe";
import chevronDown from "@iconify-icons/gravity-ui/chevron-down";
import inbox from "@iconify-icons/gravity-ui/tray";
import more from "@iconify-icons/gravity-ui/ellipsis";

const icons = { bell, squares, calendar, clock, gear, plus, arrow, chevron, check, circleCheck, shield, refresh, search, send, pause, play, edit, copy, archive, close, menu, logout, warning, lock, link, globe, chevronDown, inbox, more };
export type IconName = keyof typeof icons;

export function Glyph({ name, className = "", size = 18 }: { name: IconName; className?: string; size?: number }) {
  return <Icon icon={icons[name]} width={size} height={size} aria-hidden="true" className={className} />;
}
