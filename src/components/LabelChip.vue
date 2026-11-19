<script setup lang="ts">
/**
 * 标签 chip —— Issue / PR 的 label 展示统一入口。
 *
 * # 为什么要有这个组件
 *
 * 标签配色坑过两次（首页、仓库 Issue/PR 列表各自写了一份 `style`），
 * 且 CNB 的标签色是 `#E5F5FF` 这类浅粉彩，"标签色当文字色 + 10% 透明底"
 * 的旧写法渲染出来几乎看不见文字。配色逻辑收敛到
 * `utils/labelColor.ts`（纯函数、有单测），本组件只负责套上徽标外壳，
 * 所有调用点渲染出的标签外观必然一致。
 *
 * 无可用颜色（缺失 / 非法）时不写内联样式，退回 Nuxt UI 的中性徽标。
 */
import { computed } from 'vue'
import { labelChipStyle } from '../utils/labelColor'

const props = withDefaults(defineProps<{
  /** 标签名（展示文案） */
  name: string
  /** CNB 返回的标签色（`#E5F5FF` 等浅色；可空） */
  color?: string | null
  /** 尺寸：列表用 sm，详情页也用 sm，留出 md 供后续扩展 */
  size?: 'sm' | 'md'
}>(), {
  color: '',
  size: 'sm',
})

/** 底色 + 自动推导的前景色；无可用颜色时为 undefined（走中性样式） */
const chipStyle = computed(() => labelChipStyle(props.color))
</script>

<template>
  <UBadge
    variant="subtle"
    :size="size"
    :label="name"
    :style="chipStyle"
    class="font-medium"
  />
</template>
