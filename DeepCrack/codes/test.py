from data.dataset import readIndex, dataReadPip, loadedDataset
from model.deepcrack import DeepCrack
from trainer import DeepCrackTrainer
from weights_util import load_state_dict_from_file
import cv2
from tqdm import tqdm
import numpy as np
import torch
import os

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "0")


def test(test_data_path='data/test_example.txt',
         save_path='deepcrack_results/',
         pretrained_model='checkpoints/DeepCrack_CT260_FT1.pth', ):
    if not os.path.exists(save_path):
        os.mkdir(save_path)

    test_pipline = dataReadPip(transforms=None)

    test_list = readIndex(test_data_path)

    test_dataset = loadedDataset(test_list, preprocess=test_pipline)

    # num_workers=0 avoids multiprocessing issues on Windows
    test_loader = torch.utils.data.DataLoader(test_dataset, batch_size=1,
                                              shuffle=False, num_workers=0, drop_last=False)

    # -------------------- build trainer --------------------- #

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    num_gpu = torch.cuda.device_count() if device.type == "cuda" else 0

    model = DeepCrack()

    if num_gpu > 0:
        model = torch.nn.DataParallel(model, device_ids=range(num_gpu))
    model.to(device)

    trainer = DeepCrackTrainer(model).to(device)

    state = load_state_dict_from_file(
        pretrained_model, map_location=device, use_data_parallel=(num_gpu > 0)
    )
    model.load_state_dict(state)

    model.eval()

    with torch.no_grad():
        for names, (img, lab) in tqdm(zip(test_list, test_loader)):
            test_data = img.type(torch.FloatTensor).to(device)
            test_target = lab.type(torch.FloatTensor).to(device)
            test_pred = trainer.val_op(test_data, test_target)
            test_pred = torch.sigmoid(test_pred[0].cpu().squeeze())
            save_pred = torch.zeros((512 * 2, 512))
            save_pred[:512, :] = test_pred
            save_pred[512:, :] = lab.cpu().squeeze()
            # Save under input image basename (not dummy label path)
            stem = os.path.splitext(os.path.basename(names[0]))[0]
            save_name = os.path.join(save_path, f"{stem}_deepcrack_stack.png")
            save_pred = save_pred.numpy() * 255
            cv2.imwrite(save_name, save_pred.astype(np.uint8))


if __name__ == '__main__':
    test()
