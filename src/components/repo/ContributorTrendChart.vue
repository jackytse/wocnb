<script setup lang="ts">
/**
 * 贡献者周趋势图（T09，纯 SVG 实现，验收 2）。
 *
 * 设计约束：
 * - **不引入图表库**（本项目图表需求单一，纯 SVG 体积/依赖收益更高）；
 * - 输入 repo_data（WeekPoint[]：w 周时间戳 / c 提交数 / a 增行 / d 删行）；
 * - **空数组（或全部无提交）不渲染任何容器** —— 由 v-if 在父级控制，
 *   本组件内部对"无有效数据"同样输出注释占位，避免空 SVG 留白；
 * - 每根柱 = 一周的提交数；hover（SVG title）显示日期 + 提交/增删行明细；
 * - withLineCounts 为 false 时 a/d 恒 0，明细只显示提交数（不显示 0+0-）。
 */
import { computed } from 'vue'
import type { WeekPoint } from '../../composables/useCnbSocial'

const props = defineProps<{
  /** 周数据点（按时间升序；由数据层保证 w>0） */
  weeks: WeekPoint[]
  /** 是否有增删行统计（false 时 tooltip 不显示 +/- 行） */
  withLineCounts: boolean
}>()

/** 画布逻辑尺寸（viewBox 固定，CSS 宽度自适应容器，800px 下不横向滚动） */
const WIDTH = 680
const HEIGHT = 180
/** 图表内边距（下 24 留时间轴，上 8 留最高点余量） */
const PADDING_X = 8
const PADDING_Y = 24

/** 有效数据：至少一周有提交才绘制（全 0 视为空态） */
const hasData = computed(() => props.weeks.some(week => week.c > 0))

/** 去掉前导全 0 周（避免图表左端大片空白），最多保留最近 104 周（两年） */
const visibleWeeks = computed(() => {
  const weeks = props.weeks
  let start = 0
  while (start < weeks.length && weeks[start].c === 0) {
    start++
  }
  return weeks.slice(start, start + 104)
})

/**
 * 柱形几何参数：x 均分宽度，高度按最大提交数线性缩放（最小 2px 保证可见）。
 */
const bars = computed(() => {
  const weeks = visibleWeeks.value
  if (weeks.length === 0 || !hasData.value) {
    return []
  }
  const max = Math.max(...weeks.map(week => week.c), 1)
  const plotHeight = HEIGHT - PADDING_Y
  const step = (WIDTH - PADDING_X * 2) / weeks.length
  // 柱宽取步长的 80%，稀疏数据不至于出现超宽柱
  const barWidth = Math.max(Math.min(step * 0.8, 28), 1)
  return weeks.map((week, index) => {
    const height = Math.max((week.c / max) * (plotHeight - 4), week.c > 0 ? 2 : 0)
    const date = new Date(week.w * 1000)
    const label = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    return {
      x: PADDING_X + index * step,
      y: plotHeight - height,
      width: barWidth,
      height,
      // title 明细（SVG 原生 hover tooltip，无需额外依赖）
      title: props.withLineCounts
        ? `${label}：+${week.a} / -${week.d}（${week.c} commits）`
        : `${label}：${week.c} commits`,
    }
  })
})
</script>

<template>
  <!-- 空数据不渲染容器（验收 2）：父级 weeks 空时本组件整个不出现 -->
  <div
    v-if="hasData && bars.length > 0"
    class="w-full"
  >
    <svg
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      class="w-full h-auto"
      role="img"
      aria-label="weekly commits trend"
    >
      <!-- 柱形：primary 色半透明，hover 高亮 -->
      <rect
        v-for="(bar, index) in bars"
        :key="index"
        :x="bar.x"
        :y="bar.y"
        :width="bar.width"
        :height="bar.height"
        rx="2"
        class="fill-primary/70 hover:fill-primary"
      >
        <title>{{ bar.title }}</title>
      </rect>
      <!-- 基线 -->
      <line
        :x1="0"
        :y1="HEIGHT - PADDING_Y + 1"
        :x2="WIDTH"
        :y2="HEIGHT - PADDING_Y + 1"
        class="stroke-neutral-300 dark:stroke-neutral-700"
        stroke-width="1"
      />
    </svg>
  </div>
</template>
