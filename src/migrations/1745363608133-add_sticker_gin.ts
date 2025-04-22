import { MigrationInterface, QueryRunner } from "typeorm";

export class AddStickerGin1745363608133 implements MigrationInterface {


    public async up(queryRunner: QueryRunner): Promise<void> {
        console.log('Adding GIN index to asset.stickers');
        await queryRunner.query(`DROP INDEX IF EXISTS "asset_stickers_gin"`);
        await queryRunner.query(`CREATE INDEX "asset_stickers_gin" ON "asset" USING GIN ("stickers")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        console.log('Dropping GIN index from asset.stickers');
        await queryRunner.query(`DROP INDEX IF EXISTS "asset_stickers_gin"`);
    }

}
