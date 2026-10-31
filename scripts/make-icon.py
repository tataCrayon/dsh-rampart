"""生成 dsh-rampart 的图标：深蓝底 + 白色城墙（rampart）glyph。

寓意：插件的核心动作是「在被压垮之前筑一道墙」——采样压力、到线就拦。
城墙的垛口（merlon）在 48px 下仍然是一个可辨认的剪影，而刹车、仪表盘、
内存条这些意象在小尺寸都会糊成噪点。

按平台硬规则：方形原图、不预裁圆角、无透明像素；180px 版本用 LANCZOS 缩。
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'assets'
MASTER = 1024
SCALE = 4  # 先画 4 倍再缩，边缘才不毛

BG = (21, 78, 214, 255)      # 深蓝，压得住白 glyph
WALL = (255, 255, 255, 255)  # 墙
CAP = (147, 197, 253, 255)   # 浅蓝：墙上那道「上限」横线


def draw_master() -> Image.Image:
    size = MASTER * SCALE
    image = Image.new('RGBA', (size, size), BG)
    draw = ImageDraw.Draw(image)

    def box(left: float, top: float, right: float, bottom: float) -> tuple[int, int, int, int]:
        return (
            round(left * size),
            round(top * size),
            round(right * size),
            round(bottom * size),
        )

    # 墙体：占据画布中间 56%，上下留白足够，48px 下不会贴边
    draw.rectangle(box(0.22, 0.44, 0.78, 0.78), fill=WALL)

    # 三个垛口，中间那个略高——一眼是「城垛」而不是「三个方块」
    draw.rectangle(box(0.22, 0.31, 0.35, 0.47), fill=WALL)
    draw.rectangle(box(0.435, 0.26, 0.565, 0.47), fill=WALL)
    draw.rectangle(box(0.65, 0.31, 0.78, 0.47), fill=WALL)

    # 墙脚：一道压低的浅蓝横线，读作「水位/上限」，也把大块白压住
    draw.rectangle(box(0.22, 0.70, 0.78, 0.745), fill=CAP)

    return image.resize((MASTER, MASTER), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    master = draw_master()
    master.convert('RGB').save(OUT / 'icon-1024.png', 'PNG')
    master.convert('RGB').resize((180, 180), Image.LANCZOS).save(OUT / 'icon-180.png', 'PNG')
    print(f'已生成 {OUT}\\icon-1024.png 与 icon-180.png')


if __name__ == '__main__':
    main()
